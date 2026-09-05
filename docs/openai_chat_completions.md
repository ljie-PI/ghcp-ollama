# OpenAI Chat Completions 原生代理规范

> 状态：normative production spec
>
> 本文是 `POST /v1/chat/completions` 的唯一协议行为规范。当前或历史 JavaScript
> implementation、tests 和 fixtures 都不是行为来源。

## 1. Scope、source priority 与 non-goals

本文定义 OpenAI Chat Completions route 的：

1. `WireJson` request decoding 与 duplicate-member policy；
2. Bound Account、catalog snapshot 与 model resolution；
3. `stream`、`stream_options`、vision analysis 与 request reserialization；
4. GitHub Copilot native Chat upstream execution；
5. non-stream JSON success；
6. shared incremental Chat SSE parsing、OpenAI SSE encoding 与 successful terminal；
7. route-specific errors、commit、abort、telemetry 和验收要求。

发生冲突时，先按责任范围选择 source：

1. [Gateway HTTP contracts](./gateway_http_contracts.md) 独占 listener、loopback access、
   request media type/body limit、inference admission、timeouts、shared buffer limits、
   response commit definition、request ID、`Retry-After`、OpenAI error presenter 和公开
   redaction。
2. 本文独占 OpenAI Chat request planning、model resolution、rewritten upstream body、
   native Chat success JSON、Chat SSE parsing、OpenAI SSE bytes 和 `[DONE]` terminal。
3. [GitHub Copilot model listing](./github_copilot_model_listing_apis.md) 独占 account-scoped
   CAPI catalog、catalog cache/generation、credential、endpoint discovery 和 catalog item
   filtering。其 model-list public presenter 不用于本 route。
4. [Architecture](./architecture.md)、[CONTEXT](../CONTEXT.md) 和
   [ADR-0001](./adr/0001-protocol-endpoint-modules.md) 独占 module interface、state
   ownership 与 canonical vocabulary。
5. [AGENTS](../AGENTS.md) 独占 repository delivery workflow。
6. 其他 protocol specs 只在其自身 route 生效。尤其是
   [Ollama](./ollama_chat_to_chat_completions.md) 的 model default、response reducer 和
   NDJSON rules，
   [Anthropic](./claude_messages_to_chat_completions.md) 的 conversion/event rules，以及
   [Responses routing](./openai_responses_routing.md) 和
   [Responses bridge](./codex_response_to_chat_completions.md) 的 planning/conversion/history
   rules，都不得进入本 route。

“raw fast path” 只表示“不经过其他 downstream protocol
converter”。它不允许 byte-blind SSE passthrough；第 10–11 节的 incremental parser 和
OpenAI SSE re-encoder 对本 route 优先。

只注册：

```text
POST /v1/chat/completions
```

不得为本 module 注册 `/chat/completions`、`/v1/chat/completions/`、其他 method、旧名称或
provider-specific alias。Route matching 与 unmatched-route behavior 服从 Gateway HTTP
contracts。Inbound query 不参与 model resolution，不改变 body，也不得复制到 upstream target。

本 route 是 native Chat path：

```text
OpenAI Chat request
  -> request-local validation and model resolution
  -> GitHub Copilot /chat/completions
  -> OpenAI Chat JSON or OpenAI Chat SSE
```

它不得调用 Ollama、Anthropic、Responses request/response converter，不得建立 canonical
message model，不得读写 Responses History，也不得 fallback 到 legacy handler、native Responses
或另一个 protocol。

## 2. Logical interfaces 与 immutable request context

以下是 logical interfaces；implementation 可以把小型 helper 合并在同一 file，但不得丢失其
语义边界：

```text
createOpenAiChatEndpoint(dependencies) -> ProtocolEndpoint

decodeOpenAiChatRequest(root: WireJsonObject)
  -> DecodedOpenAiChatRequest | InvalidRequest

resolveOpenAiChatModel(
  decoded: DecodedOpenAiChatRequest,
  account: BoundAccount,
  catalog: CatalogSnapshot
) -> ResolvedModel | InvalidRequest | ModelNotFound

prepareOpenAiChatRequest(
  decoded: DecodedOpenAiChatRequest,
  resolved: ResolvedModel
) -> PreparedOpenAiChatRequest | InvalidRequest
```

```text
PreparedOpenAiChatRequest {
  body: WireJsonObject
  bytes: Uint8Array
  stream: boolean
  hasVisionInput: boolean
  resolvedModel: string
}

OpenAiChatRequestContext {
  requestId: string
  signal: AbortSignal
  config: RuntimeConfigSnapshot
  account: BoundAccount
  copilot: BoundCopilot
  catalog: CatalogSnapshot
  model: ResolvedModel
}
```

`PreparedOpenAiChatRequest.body` 必须仍是 ordered `WireJsonObject`，不能先转成会重排
integer-like keys、折叠 duplicate members 或改变 number lexeme 的普通 JavaScript object。
`ResolvedModel` 使用 [shared model resolution contract](./architecture.md#model-resolution)；本 route 只消费 immutable
`source` 与 `upstreamModel`，不使用其 Responses routing metadata 做第二次 planning。

一次 admitted request 的 execution order 是：

1. Gateway Foundation 捕获一个 immutable `RuntimeConfigSnapshot` 并完成 shared HTTP body
   parsing。
2. OpenAI Chat decoder 完成所有可在 account binding 前判断的 local validation。
3. `AccountDirectory` 恰好 bind 一次默认 `BoundAccount`。
4. 对该 `accountId` 恰好取得一个 current `CatalogSnapshot`。
5. 只在该 snapshot 上执行一次 model resolution。
6. `CopilotBackend` 对同一 Bound Account 恰好 bind 一个 `BoundCopilot`，固定 credential 与
   target。
7. 只构造一次 final request、vision flag 和 serialized bytes。
8. 根据 `stream` 恰好调用一次 `completeChat` 或 `openChatStream`。

步骤 3–8 一旦完成，对应值在 request lifetime 内不变。Default account、preferred model、
catalog cache、credential、target 或 runtime config 的 concurrent update 只影响后续 request。
不得在 upstream failure 后重新 bind、重新取 catalog、重新 resolve model 或改变 execution path。

“一次 upstream call”在本文指一次 Chat inference invocation。Catalog service 在 cache miss 时是否
执行其自身 CAPI fetch，完全由 model-listing spec 管理；OpenAI Chat module 不复制、绕过或重试该
逻辑。

## 3. `WireJson` request decoder

Gateway 按 Gateway HTTP contracts 先得到一个完整、合法、受限且 root 为 object 的
`WireJson`。本 module 只能从该 object decode，不能对 raw bytes 再调用 `JSON.parse()`。

### 3.1 Top-level duplicate policy

所有 top-level decoded member names 必须唯一。任何 duplicate 都是
`400 invalid_request_error`，包括：

- duplicate `model`、`stream`、`stream_options` 或 `messages`；
- duplicate unknown member；
- 不同 JSON spelling 解码为同一 string，例如 `"model"` 与 `"\u006dodel"`。

比较使用解码后的、大小写敏感的完整 member name；`Model` 与 `model` 是不同 keys。该规则在读取
任何 control member 前执行，因此 implementation 不得采用 first-wins、last-wins 或普通 object
parse 的隐式结果。

Nested objects 不应用通用 duplicate rejection。唯一额外 control-member rule 是第 6.2 节对
`stream_options.include_usage` 的规定。

### 3.2 Local schema boundary

除本文明确规定的 `model`、`stream` 和 stream-true `stream_options` 外，本 module 不建立
top-level allowlist，也不对 Chat fields 做会丢失 forward-compatible values 的 normalization。

因此：

- missing `messages`、未知 Chat fields 或 provider extension fields 可以进入 upstream；
- 它们的 upstream acceptance 由 GitHub Copilot Chat endpoint 决定；
- local decoder 不 trim strings、不 coerce number/string/bool，也不注入 Chat defaults；
- malformed JSON、non-object root、media type、encoding 和 request byte limit 仍由 Gateway HTTP
  contracts 在进入本 decoder 前拒绝。

## 4. Model resolution

Model lookup 始终使用第 2 节捕获的 Bound Account 和该 account 的单一 current
`CatalogSnapshot`。Catalog membership 只比较 `CatalogSnapshot.models[].id`；不得使用 model
name、vendor、routing metadata、静态 allowlist 或其他 account 的 catalog。

### 4.1 Explicit `model`

当 top-level `model` property 存在时：

1. value 必须是 string；
2. string length 必须大于 0；
3. 不 trim、不改大小写、不执行 alias、dash/dot rewrite、family fallback 或 deployment mapping；
4. 必须与 captured catalog 中至少一个 `id` 完全相等。

Non-string 或 `""` 是 `400 invalid_request_error`，safe message 为 `invalid request`。
一个 nonempty string 若没有 exact catalog match，是 route-local
`404 not_found_error`，safe message 为 `model not found`。Whitespace-only string 是 nonempty；
若 catalog 没有同值 ID，它属于 `404 model not found`，不能 trim 后变成另一个 model。

Explicit model 不读取 preferred model，也不得在 not-found 时 fallback。

### 4.2 Missing `model`

只有 top-level property 完全 missing 时才使用 Bound Account 的 preferred model。`null`、`false`、
number、object、array 和 empty string 都不是 missing。

Preferred model 必须同时满足：

1. account 有一个 nonempty string captured preferred model；
2. preference state 是 `valid`；
3. preferred model ID 与 captured catalog 中至少一个 `id` 完全相等。

满足时 `source="preferred"`，并使用该 exact ID。Preference missing、已标记 invalid 或不再存在于
captured catalog 时，返回 `400 invalid_request_error` 与 safe `invalid request`。不得选择 catalog
第一项、上次成功 model 或全局 default，也不得把该情况呈现为 explicit-model 404。

Catalog fetch/parse/auth/network failure 不是 “model not found”；它保持原 failure category，并由
Gateway OpenAI presenter 映射。

### 4.3 Resolved value

`ResolvedModel.upstreamModel` 对 explicit model 是原 string value，对 preferred model 是
preference 中的 exact catalog ID。Final upstream body 的 `model` 必须替换为该值；downstream
response 中的 `model` 不做反向重写。

## 5. `stream` selection

Top-level `stream` 使用严格 JSON boolean rules：

| Inbound value | Execution path |
| --- | --- |
| missing | non-stream |
| `false` | non-stream |
| `true` | stream |
| null、string、number、array、object | `400 invalid_request_error` |

Missing 时不向 final body 注入 `stream:false`。Explicit `false` 或 `true` 保持原 member position 和
boolean value。Truthiness、string `"true"`、number `1` 和 coercion 均禁止。

## 6. `stream_options.include_usage`

### 6.1 Non-stream

当 `stream` missing 或为 `false` 时，`stream_options` 不参与 local validation 或 mutation：

- missing 时不创建；
- present 时保留原 `WireJson` value 和 member position；
- GitHub Copilot 可以按 upstream semantics 接受或拒绝它。

### 6.2 Stream

当且仅当 `stream === true` 时，final body 必须具有：

```json
{"stream_options":{"include_usage":true}}
```

处理规则：

1. `stream_options` missing：创建 object，并添加 `include_usage:true`；
2. `stream_options` 是 object：保留其他 members 的 source order 和 values；
3. object 中没有 `include_usage`：在该 object 的末尾追加；
4. object 中恰好一个 `include_usage`：在原 position 把 value 覆盖为 boolean `true`，不论原类型；
5. object 中 duplicate decoded `include_usage`：`400 invalid_request_error`；
6. `stream_options` 为 null、boolean、string、number 或 array：
   `400 invalid_request_error`。

Unknown nested members，包括它们的 ordered values，不得因 gateway 注入 usage 而丢失。

<a id="request-reserialization-and-vision"></a>

## 7. Request reserialization 与 vision analysis

### 7.1 Ordered reserialization

所有 valid request 都必须重新序列化；不得把 inbound raw body 原样转发。Final body 使用 compact
UTF-8 JSON，无 BOM、无 trailing LF、无 insignificant whitespace。

按 original top-level members 顺序逐项处理：

1. Existing `model` 在原 position 输出，value 替换为 resolved model；
2. Existing stream-true `stream_options` 在原 position 按第 6.2 节输出；
3. 其他所有 members，包括 unknown 和 provider extension fields，保持相对 source order 和
   `WireJson` value；
4. Missing `model` 在所有 original members 之后追加；
5. Stream-true 且 missing `stream_options` 时，在所有 original members 和可能追加的 `model`
   之后追加；若 model 也 missing，append order 是 `model` 后 `stream_options`。

Serializer 必须保留：

- object member order；
- array order；
- string、boolean 与 null values；
- number lexeme，包括 exponent、large integer 和 `-0`；
- nested unknown objects/arrays。

只允许改变 `model` 和 stream-true `stream_options.include_usage`，以及为缺失的这两个 gateway-owned
members执行上述 insertion。不得按字段白名单重建 request，也不得修改 `messages`、tools、tool
arguments、sampling fields 或 provider extensions。

### 7.2 Vision flag

Vision analysis 是只读 side analysis。`hasVisionInput=true` 仅当 top-level `messages` array 中至少
一个 message 的 `content` array 含 OpenAI Chat `image_url` part，即 part object 的 decoded
`type` 为 exact string `"image_url"` 且存在 `image_url` member。

Rules：

- 只扫描 `messages[*].content[*]`，不扫描 tools、metadata、unknown fields 或 arbitrary strings；
- 不 fetch URL、不 decode base64、不验证 MIME type；
- 不改变、删除、规范化或重新排序任何 message/content/image member；
- 不因无法识别的 message shape 产生额外 local schema error；它只是不设置 flag；
- inbound `copilot-vision-request` 或同名大小写变体 header 不能设置、清除或覆盖该 flag。

Backend 在 flag 为 true 时加入 typed outbound header：

```http
copilot-vision-request: true
```

Flag 为 false 时不发送该 header。

## 8. Native Chat upstream

OpenAI Chat module 只能调用 captured `BoundCopilot` 的 Chat methods。Production backend 按
`BoundCopilot.target` 的 target-construction contract 构造最终 URL，并追加 exact
`/chat/completions` path；不得从 inbound `Host`、path、query、body extension 或 header 构造
target。

Examples：

```text
https://api.githubcopilot.com
  -> https://api.githubcopilot.com/chat/completions

https://copilot.example.com/capi
  -> https://copilot.example.com/capi/chat/completions
```

Target normalization 和 credential lifecycle 由 BoundCopilot/Copilot backend ownership 管理；
protocol module 不重复 endpoint discovery。

Outbound request 使用：

```http
Content-Type: application/json
copilot-integration-id: vscode-chat
editor-version: vscode/1.110.1
editor-plugin-version: copilot-chat/0.38.2
user-agent: GitHubCopilotChat/0.38.2
x-github-api-version: 2025-10-01
```

Authorization/credential 由 captured BoundCopilot 生成；vision header 只来自第 7.2 节 typed flag。
Inbound `Authorization`、`x-api-key`、Copilot identity/version、vision、request-ID 或 forwarding
headers 都不得覆盖 fixed outbound values或成为 upstream credential。Arbitrary upstream
response headers 也不得覆盖 gateway-generated public request ID。

对 prepared request 恰好选择一个：

```text
stream == false -> BoundCopilot.completeChat(...)
stream == true  -> BoundCopilot.openChatStream(...)
```

Endpoint 不执行 application-level retry，不改发 `/responses`，不切换 account/model/target，也不在
failure 后调用另一个 method。Transport 自身的 connection management 必须遵守 Copilot backend
contract，但不能使 endpoint 产生第二个 logical Chat inference attempt。

Final non-2xx status 不进入 success parser。其 status、safe error rebuild 和唯一允许的
`Retry-After` 按 Gateway HTTP contracts。

## 9. Non-stream success

Final upstream status 为任意 `2xx` 时，必须在 downstream commit 前：

1. 在 captured `limits.nonstreamBodyBytes` 内完整读取 decoded body；default 是 32 MiB；
2. 验证 bytes 是合法 UTF-8 JSON；
3. 验证 root 是 object；
4. 使用 ordered `WireJson` compact serializer 重新生成 UTF-8 bytes；
5. 从 `usage` 做第 13 节 side observation，但不改变 body。

Empty body、whitespace-only body、malformed JSON、invalid UTF-8、null、array、string、number 或
boolean root 都是 `invalid_upstream_response`。超过 shared limit 也按该 category 失败；不得截断、
返回 partial object 或尝试 stream parser。

Valid object success：

- 保留全部 upstream top-level/nested fields、member order、array order、values 和 number lexemes；
- 不建立 response field allowlist；
- 不删除 unknown/provider fields；
- 不重写 `id`、`object`、`created`、`model`、`choices`、tool calls、reasoning 或 `usage`；
- inbound resolved model 不用于覆盖 response model；
- final upstream `2xx` status 原样作为 downstream success status；
- response body 是 compact JSON，无 BOM 或 trailing LF；
- response `Content-Type` 固定为：

```http
Content-Type: application/json; charset=utf-8
```

Gateway 另加入该 request 的 `x-request-id`。Upstream `Content-Type`、`Content-Length`、
`Content-Encoding` 和 hop-by-hop headers 不决定重新序列化后的 downstream representation。

## 10. Shared incremental Chat SSE parser

Stream path 必须使用 shared incremental Chat SSE parser，输出：

```text
ChatStreamFrame =
  | { kind: "chunk", chunk: ChatChunk }
  | { kind: "error", value: WireJson | string }
  | { kind: "done" }
```

OpenAI Chat endpoint 只消费该 union；不得扫描 arbitrary raw chunks寻找 `[DONE]`，也不得把 upstream
bytes直接写给 downstream。

### 10.1 Framing

Final upstream `2xx` body 按以下 grammar 增量处理：

1. 使用一个 fatal incremental UTF-8 decoder；multibyte code point 可跨任意 transport chunk；
2. 只允许 stream 最开头一个 UTF-8 BOM，并忽略它；
3. 接受 LF、CRLF 和 CR line endings，跨 byte split 正确识别；
4. 空行结束当前 SSE event；
5. `:` 开头的 comment line 被忽略；
6. Field line 在第一个 `:` 分隔；value 只移除开头至多一个 U+0020 SPACE；
7. 多个 `data` fields 按出现顺序用单个 LF 连接；
8. 没有 `data` 的 event 被忽略；
9. `event`、`id`、`retry` 和 unknown SSE fields 不进入 `ChatChunk`；
10. 一个 event 的全部 buffered bytes 受 captured `limits.sseEventBytes` 约束，default 是
    4 MiB。

Comments、unknown fields、line endings 和 transport chunks 都不是 downstream payload。

### 10.2 Frame decoding

Event data 完成后按顺序分类：

1. Data 精确等于 `[DONE]` 时产生 `kind:"done"`；
2. Final SSE event type 精确等于 `error` 时产生 `kind:"error"`；
3. 其他 data 必须是一个合法 JSON object；
4. Object root 含 decoded top-level `error` member 时产生 `kind:"error"`；
5. 其他 object 必须通过 shared `ChatChunk` decoder，并产生 `kind:"chunk"`。

`[DONE]` 比较不 trim。` [DONE]`、`[DONE] `、JSON string `"[DONE]"` 或不同大小写都不是 terminal。
Malformed JSON、non-object JSON、invalid Chat chunk、event limit overflow 或 serializer failure 是
invalid upstream stream response。

Parser 在 first `done` 或 `error` 后进入 absorbing terminal state；endpoint 停止拉取并释放 upstream
body。Normal iterator exhaustion 不是 `done`。

### 10.3 EOF

只有收到 `kind:"done"` 才能成功结束。以下全部是 failure：

- clean EOF 但从未收到 `done`；
- EOF 时有 incomplete UTF-8 code point；
- EOF 时有 residual line、field、data 或 unterminated event；
- EOF 前最后一个 event 是 malformed/invalid；
- transport 在 event 中途关闭。

即使先前 chunk 已含 non-null `finish_reason`，也不能把 EOF 当成 `[DONE]`。

<a id="downstream-sse-wire-and-terminal"></a>

## 11. OpenAI downstream SSE wire 与 terminal

Stream success 使用：

```http
Content-Type: text/event-stream; charset=utf-8
```

Gateway 另加入该 request 的 `x-request-id`。Final upstream `2xx` status 保持为 downstream
success status。

每个 `kind:"chunk"` 独立使用 ordered compact JSON serializer，并恰好输出：

```text
data: <compact-json>\n\n
```

也就是 bytes：

```text
64 61 74 61 3a 20 <json bytes> 0a 0a
```

Rules：

- 保留 chunk 的全部 fields、member order、values 和 number lexemes；
- 不建立 choice/delta/provider field allowlist；
- usage-only chunk，例如 `choices:[]`，仍完整输出；
- upstream comments、`event:`、`id:`、`retry:`、unknown SSE fields、blank events 和原 line
  endings 均不输出；
- 不复制 upstream framing whitespace；downstream framing 永远使用上述 exact LF bytes；
- 不调用 Ollama、Anthropic 或 Responses reducer/encoder。

First `kind:"done"` 是唯一 successful terminal。Endpoint 恰好输出一次：

```text
data: [DONE]\n\n
```

然后结束 stream、停止读取 upstream 并释放 parser。Zero-chunk 后直接 `done` 是合法 empty success。
Duplicate `[DONE]`、post-DONE data 或 comments 不得产生第二个 terminal 或其他 bytes。

`kind:"error"` 永远是 failure；其 data 不得作为 OpenAI chunk 或 public error body 下发。EOF/no-Done、
parser error、event overflow、transport error 或 timeout 也都是 failure。任何 failure 都不得合成
`data: [DONE]\n\n` 或 `data: {"error":...}\n\n`。

## 12. Errors、commit、backpressure 与 abort

### 12.1 Pre-commit presenter

所有 pre-commit failure 使用 Gateway HTTP contracts 的 OpenAI presenter：

```json
{"error":{"message":"<safe message>","type":"<error type>","param":null,"code":null}}
```

Explicit unknown model 产生 Gateway HTTP contracts 已定义的 shared `model_not_found` failure：

| Condition | Status | `error.type` | Safe message |
| --- | ---: | --- | --- |
| Explicit nonempty model 不在 captured account catalog | 404 | `not_found_error` | `model not found` |

对应 exact compact body 是：

```json
{"error":{"message":"model not found","type":"not_found_error","param":null,"code":null}}
```

以下 Chat-specific failures 使用已有 mapping：

| Condition | Failure category | Status | Safe message |
| --- | --- | ---: | --- |
| Duplicate top-level member | `invalid_request` | 400 | `invalid request` |
| Explicit model non-string/empty | `invalid_request` | 400 | `invalid request` |
| Missing model 且 preference missing/invalid/not-in-catalog | `invalid_request` | 400 | `invalid request` |
| `stream` wrong type | `invalid_request` | 400 | `invalid request` |
| Stream-true `stream_options` wrong type或 duplicate `include_usage` | `invalid_request` | 400 | `invalid request` |
| Invalid/oversized upstream `2xx` non-stream body | `invalid_upstream_response` | 502 | `invalid upstream response` |
| Pre-commit SSE error frame、parse error、overflow、EOF without Done | `invalid_upstream_response` | 502 | `invalid upstream response` |

Account、credential、catalog transport、admission、timeout、network 和 final upstream non-2xx
继续使用 Gateway HTTP contracts 的 category/status rules。Local 400/404 不生成 `Retry-After`。
Final upstream 429 只有满足 shared single-valid-value rule 才能保留它。

即使 request 的 `stream` 为 true，pre-commit error 仍是普通 JSON，不是 SSE。所有 error response
具有 shared `Content-Type`、`Cache-Control: no-store` 与 gateway-generated `x-request-id`。
Public body/log 不得包含 requested model、account metadata、catalog content、credential、target URL、
upstream headers/body、messages、images、tools 或 exception text。

### 12.2 Commit boundary

Non-stream 只有在完整 body 读完、limit 检查、UTF-8/JSON/object validation、usage observation 和 final
serialization 都成功后才能 commit。

Stream 只有在：

1. final upstream status 已知为 `2xx`；
2. first downstream payload 对应的完整 frame 已 framing、decoded、validated；
3. 该 payload 的 exact downstream bytes 已成功构造；

之后才能 commit。Upstream headers、SSE comment、blank/no-data event 或预先 flush 的 SSE headers 都
不能触发 commit。

First payload 可以是 Chat chunk 或 `[DONE]`。First frame 若是 error，或 EOF/timeout 在 first payload
前发生，必须返回普通 HTTP error。

### 12.3 Post-commit failure

第一个 downstream body byte 写出后，HTTP status/headers 不得替换。任何 non-abort failure：

1. abort/cancel same upstream operation；
2. 调用 active iterator 的 `return()`；
3. 释放 body、decoder、timer、listener、request state 和 admission permit；
4. 直接关闭 downstream connection；
5. 不追加 error frame、JSON body、SSE comment 或 `[DONE]`。

因此，一个已输出 chunks 但没有 `[DONE]` 的 response 在 wire 上保持 truncated；不得伪装为 success。

### 12.4 Pull backpressure

Pipeline 必须是 pull-based：

```text
downstream pull
  -> OpenAI SSE encoder
  -> ChatStreamFrame iterator
  -> incremental SSE parser
  -> upstream body pull
```

一次最多保留一个尚未被 downstream 消费的 emit-ready frame。Parser 为跨 chunk UTF-8、line 和 current
event保存的 bounded state 不算预取。Comments/no-data events 可以在一次 pull 内被跳过，但不得启动
background reader、callback pump 或 unbounded queue。

### 12.5 Client abort

Client disconnect/cancellation 在 queue、body read、account/catalog/credential wait、connect、
pre-first-byte、mid-stream 或 terminal write 的任意阶段都必须：

- abort 同一个 upstream/catalog operation；
- 从 queue 移除 waiter 或恰好释放一次 active permit；
- 调用 iterator `return()`；
- 释放 timer、listener、body、socket、decoder 和 request-local state；
- 从 abort 时刻起写零个新增 bytes；
- 不记录 public error，不合成 `[DONE]`。

Abort 不是 timeout，也不能触发 account/model retry。

<a id="usage-and-telemetry"></a>

## 13. Usage 与 telemetry ownership

OpenAI Chat module 可以从 valid upstream object/chunk 的 top-level `usage` 生成 content-free
`ChatUsageObservation`，但 wire body/event 始终保留原始 `usage` value。

```text
ChatUsageObservation {
  promptTokens?: nonnegative integer
  completionTokens?: nonnegative integer
  cachedTokens?: nonnegative integer
}
```

Mapping：

- `usage.prompt_tokens` -> `promptTokens`；
- `usage.completion_tokens` -> `completionTokens`；
- `usage.prompt_tokens_details.cached_tokens` -> `cachedTokens`。

Telemetry extraction 不 coerce string/bool/float，不从 `total_tokens` 推导缺失字段。它不增加第 9 节
root-object validation 或第 10 节 shared `ChatChunk` decoder 之外的 validation。一个已被对应 success
decoder 接受的 malformed、duplicate 或不可表示 usage member只使对应 observation 缺失；不得修改或
删除该 member。

Non-stream 最多产生一个 observation。Stream 中每个含 usage 的 typed chunk 都仍按第 11 节输出；
request-local telemetry state 对每个 valid counter采用 last-valid-wins，后续 missing/invalid value
不清除先前 valid value。Request terminal 时向 `UsageRecorder` 提交至多一个 content-free sample。

`UsageRecorder`/telemetry module 独占 batching、SQLite retention、outcome counters 和 bounded overflow
policy。OpenAI Chat endpoint 只提供：

```text
accountId
protocol = "openai_chat"
resolvedModel
outcome
latency
observed token counters
```

它不得提供 prompt、response、message、image URL/data、tool name/arguments/result、credential、完整
target、catalog 或 arbitrary inbound fields。Gateway request ID 可以进入 sanitized operational log，
但不能成为 Usage Bucket label。Telemetry enqueue/flush failure 是 noncritical，不得改变 success
bytes、commit boundary 或 terminal。

## 14. Normative test matrix

全部 tests 必须 offline，使用 scripted `AccountDirectory`、`CopilotModelCatalog`、
`CopilotBackend`、deterministic request ID/config 和可控制 byte boundaries 的 upstream。不得读取
developer credential、本机 provider checkout 或 remote API。

### 14.1 Route、decoder 与 immutable context

- 只有 exact `POST /v1/chat/completions` registered；method、trailing slash 和 aliases 不进入
  endpoint。
- Gateway JSON/media/body-limit/admission/timeout/request-ID cases 继续运行 shared contract suite。
- 每个 top-level duplicate case，包括 unknown 与 escaped-equivalent key，返回 exact 400，且零
  account/catalog/Chat calls。
- Unknown fields、integer-like keys、large/exponent/`-0` numbers、nested arrays/objects 保持 order、
  lexeme 和 value。
- Account、catalog、resolved model 与 config snapshot 各捕获一次；在 request 中途切换 default
  account、preference、catalog generation 或 config 不改变 captured request。

### 14.2 Model resolution

- Explicit exact model 命中当前 account catalog；
- Explicit model 为 null、bool、number、array、object、`""`；
- Whitespace/case/dash/dot 差异不 normalization；
- Explicit unknown model exact 404 body/header，且零 Chat call；
- Missing model 使用 valid preferred model；
- Missing/invalid/not-in-catalog preference exact 400，且不选择 first catalog item；
- Catalog empty、duplicate IDs、另一个 account 有同名 model；
- Catalog retrieval failure 保持真实 failure category，不伪装 404；
- Final captured upstream body 中只有一个 resolved `model`。

<a id="request-capture-tests"></a>

### 14.3 Stream selection、options、vision 与 request capture

- `stream` missing/false/true 与每种 wrong type；
- Non-stream `stream_options` missing、object、null/scalar 保持不变；
- Stream-true options missing、empty object、existing false/null/scalar `include_usage`、
  unknown members before/after、duplicate `include_usage` 和 non-object options；
- Existing replacement position、missing append position、model + options 双 missing 的 append order；
- Vision match/non-match、invalid message shapes、image fields outside messages；body逐 value不变；
- Inbound credential/identity/vision/request-ID headers不能覆盖 outbound headers；
- Captured URL、headers 和 exact compact request bytes；
- 每个 successful prepared request恰好一次 `completeChat` 或 `openChatStream` call，且不调用任何
  protocol converter/fallback。

### 14.4 Non-stream

- 每个 representative `2xx`，包括非 200 status；
- Empty、malformed、invalid UTF-8、null/array/scalar root；
- Shared non-stream limit boundary 与 boundary + 1，default fixture 使用 32 MiB；
- All upstream fields、duplicates、unknown/provider fields、member order、number lexeme 和 compact
  exact bytes；
- Response model/ID/choices/reasoning/tools 不改写；
- Usage absent/valid/malformed/duplicate：wire不变，side observation符合第 13 节；
- Invalid response 在 commit 前为 exact 502，且不返回 partial body。

<a id="stream-parser-and-wire-tests"></a>

### 14.5 Stream parser 与 exact wire

同一 fixture 必须在 every byte split point 运行，包括 multibyte UTF-8 内部，并覆盖：

- BOM、LF、CRLF、CR；
- comment、blank event、unknown fields、`id`/`retry`、multiple `data` lines；
- role/content/tool/reasoning/provider-extension chunks；
- usage-only chunk 与 multiple usage observations；
- exact compact `data: <json>\n\n` bytes；
- exact `[DONE]`、zero-chunk Done、duplicate Done 和 post-Done data；
- `[DONE]` 前后 whitespace、wrong case 和 JSON string；
- `event:error`、root `error` object 和 confidential error payload redaction；
- malformed/non-object JSON、invalid UTF-8、residual line/event/code point；
- clean EOF without Done 和 finish-reason-without-Done；
- SSE event limit boundary 与 boundary + 1，default fixture 使用 4 MiB；
- upstream comments/other fields 不出现在 downstream；
- parser/transport/timeout failure 在 first byte 前返回 JSON 502，在 first byte 后只关闭；
- success terminal恰好一次，failure/abort terminal 为零次。

### 14.6 Backpressure、abort 与 resource closure

- Slow downstream 不触发 upstream background reads，最多一个 unconsumed emit-ready frame；
- Abort while queued、reading body、binding account/catalog、connecting、before first frame、mid-frame、
  between frames、during terminal write；
- 每个 abort 从该时刻起新增 bytes 为零；
- Same upstream operation 被取消，iterator `return()` 被调用；
- Permit、timer、listener、body、socket、decoder 与 request state 恰好释放；
- Repeated success/failure/abort 后 active counters 归零且不存在 unbounded retained chunks。

Request capture fixtures 必须断言 complete URL、fixed identity headers、vision header presence、exact body
bytes 和 logical Chat call count；只做 parsed-object deep equality 不足以替代 wire golden。

## 15. Completion criteria

Implementation 只有同时满足以下条件才完成：

1. 本 route 是唯一 registered OpenAI Chat route，且始终使用 native Chat upstream path。
2. Decoder 使用 `WireJson`，拒绝全部 top-level duplicates，并保留非-owned fields 的 order、
   values 和 number lexemes。
3. Explicit model exact-match、preferred-model fallback、404/400 distinction 与 captured account catalog
   完全符合第 4 节；不存在 silent fallback。
4. Account、catalog、model、BoundCopilot target 与 config 对一次 request immutable。
5. Final request只按第 6–7 节修改 `model`/stream-true `stream_options`；vision 只产生 typed flag。
6. Non-stream 对任意 valid `2xx` object 保留全部 fields并 compact reserialize；invalid/oversized body 在
   commit 前失败。
7. Stream 经过 shared incremental parser和 OpenAI encoder；comments/other SSE fields不下发，usage
   chunk保留，success必须且只输出一个 exact `[DONE]`。
8. EOF/no-Done、error frame、truncation、timeout 与 parser failure 不会合成 success terminal；
   pre-commit 使用普通 OpenAI HTTP error，post-commit只关闭。
9. Pull backpressure、same-operation cancellation、abort零新增 bytes与 resource release全部通过。
10. Usage 只做 content-free side aggregation，不改变 body/event或成为 response success 的前置依赖。
11. 全部 fixtures offline，并覆盖 every byte split、request capture、exact wire、shared limit
    boundaries、abort和 one Chat upstream call。
12. Local links、Markdown fences与 tables有效，`git diff --check -- docs/openai_chat_completions.md` 通过。
