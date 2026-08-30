# Gateway HTTP 公开契约

> 状态：normative production contract
>
> 本文定义公开 HTTP wire behavior。除本文明确交给协议生产规范的部分外，实现、测试和后续重构都必须
> 遵守本文；当前或历史 JavaScript 实现不是行为来源。

## 1. 范围、术语与优先级

本文只规定公开兼容路由的：

- listener 与 route surface；
- request media type、JSON parsing、版本 header 和 body limit；
- inference admission、timeout 与 response commit boundary；
- 首字节前的 failure taxonomy、HTTP status、headers 和协议 error presenter；
- 首字节后的 failure/abort closure；
- `Retry-After`、request ID 与公开错误的安全边界。

本文不重复 request/response conversion mapping。成功 response、SSE/NDJSON event、字段顺序、tool、
reasoning、usage、terminal 和 exact protocol bytes 仍分别由以下生产规范定义：

- [OpenAI Responses 上游路由](./openai_responses_routing.md)
- [Responses → Chat Completions](./codex_response_to_chat_completions.md)
- [OpenAI Chat Completions native proxy](./openai_chat_completions.md)
- [Anthropic Messages → Chat Completions](./claude_messages_to_chat_completions.md)
- [Ollama Chat → Chat Completions](./ollama_chat_to_chat_completions.md)
- [GitHub Copilot 模型列表](./github_copilot_model_listing_apis.md)

发生冲突时使用以下优先级：

1. 本文对 HTTP host、pre-commit error、limits、admission、timeouts、request IDs 和
   `Retry-After` 的明确规定；
2. route 对应的生产规范对 success、conversion、protocol stream 和本文明确引用的 error behavior
   的规定；
3. [目标架构](./architecture.md) 对 module ownership 与内部依赖的规定；
4. 固定 primary source 只作为上述规范的行为出处，不形成可在运行时切换的 profile。

`pre-commit` 指 downstream response body 的第一个 byte 尚未写给 client；`post-commit` 指至少一个
downstream response body byte 已写出。设置内部状态、取得 upstream headers 或构造 `Response`
object 不得被当成已经 commit。

本文是公开 wire contract，不是稳定的内部 `GatewayFailure`、`TransformError` 或 `BridgeError`
DTO。实现可以重构内部 discriminated union，但不得因此改变本文的 status、headers、body 或
post-commit closure。

当本文和被引用规范都没有确认某项行为时，不得从 SDK、旧代码或相似 route 猜测。特别是 scheduler
公平性、未匹配 route 的 error body、HTTP/1.1 与 HTTP/2 选择、CORS，以及未明确允许的 query
semantics，不属于本文的稳定契约。

## 2. Listener 与 route matrix

### 2.1 Listener

- 唯一允许的 bind host 是 literal `127.0.0.1`；startup port 默认 `31400`，可配置为 `1..65535`。
- 首个 production release 必须拒绝 non-loopback bind，而不是在 non-loopback 上降级运行。
- 下表中的公开兼容路由不要求 gateway API key。缺少 `Authorization`、`x-api-key` 或其他 client
  credential header 不能触发 gateway authentication error。
- GitHub/Copilot credential 由 gateway 自己的 Bound Account 提供。入站 header 不得覆盖或成为
  upstream credential。

这里的“无 gateway key”不等于 gateway 必有可用 GitHub/Copilot account。账号不存在、credential
无效或 upstream 拒绝仍按各 presenter 返回 authentication/permission failure。

### 2.2 受本文约束的 routes

| Method | Path | Request | Success wire owner | Pre-commit error owner | Inference admission |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat JSON object | OpenAI Chat native proxy spec | OpenAI presenter | 是 |
| `POST` | `/v1/responses` | OpenAI Responses JSON object | native Responses 或 Chat bridge 规范 | OpenAI presenter | 是 |
| `POST` | `/v1/messages` | Anthropic Messages JSON object | Anthropic JSON/SSE 规范 | Anthropic presenter | 是 |
| `POST` | `/api/chat` | Ollama Chat JSON object | Ollama JSON/NDJSON 规范 | Ollama presenter | 是 |
| `GET` | `/v1/models` | 无 JSON request contract | Model listing 规范；header presence 可选择 Anthropic success serializer | 始终为 OpenAI model-list presenter | 否 |
| `GET` | `/api/tags` | 无 JSON request contract | Ollama model-list serializer | Ollama model-list presenter | 否 |

`GET /api/version`、`GET /healthz`、`GET /readyz` 与 `/admin/*` 由 architecture 注册，但其 success
payload、admin authentication 和管理错误不由本文定义，也不进入 inference admission。

不得注册 `/models`、`/responses`、`/openai/v1/responses`、`/claude/v1/messages`、
`/v1/responses/compact`、`/v1/ollama/*` 或尾斜杠 alias。上述 alias 必须为未匹配 route；除已有生产
规范明确要求 404 外，未匹配 route 的 body 不在本文中稳定化。

`GET /v1/models` 和 `GET /api/tags` 的 query string 不得绕过 model catalog cache 或改变结果。其他
route 的 query semantics 只有在对应生产规范明确规定时才成立。

### 2.3 Probe routes

Probe routes do not bind an account、consume inference admission or contact upstream。All responses use
`Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`。

| Route | Status | Exact compact body |
| --- | ---: | --- |
| `GET /api/version` | 200 | `{"version":"0.1.0"}` |
| `GET /healthz` | 200 | `{"status":"ok","version":"0.1.0"}` |
| `GET /readyz` when ready | 200 | `{"status":"ready"}` |
| `GET /readyz` when not ready | 503 | `{"status":"not_ready"}` |

Version is the target `ghc-gateway` package version from the refactor build's single version source；it is not an Ollama
compatibility version and must equal `package.json` at final cutover。

Ready means startup config is valid、SQLite is open at the current migration set、the protected credential-store path
has passed permission checks、runtime config snapshot exists and the host can accept requests。It does not require an
authenticated account or successful remote probe。Runtime performance `degraded` remains ready。A functional loss of any
required local dependency changes readiness to not-ready；the body never exposes which dependency failed。

Only exact GET routes are registered。Other methods and trailing-slash variants are unmatched。Probe bodies do not
include public request-ID headers。

## 3. Request parsing、版本与 media type

### 3.1 JSON requests

四个 `POST` route 只支持 JSON object：

1. 支持的 request media type 是 `application/json`；`application/json; charset=utf-8` 也是受支持
   的明确形式。Media type 与 parameter name/value 按 HTTP 规则大小写不敏感。
2. 其他 media type、显式非 UTF-8 charset 或无法解析的 `Content-Type` 是
   `unsupported_media_type`。不得把 `text/plain`、`application/*+json` 或缺少 JSON media type
   的 body 猜成 JSON。
3. `Content-Encoding` 只允许缺失或单个 `identity`；gzip、brotli、deflate、重复/合并值和未知
   encoding 都是 `unsupported_media_type`，gateway 不解压 inbound body。
4. 空 body、malformed JSON、JSON root 不是 object，以及 route schema validation failure 都是
   `invalid_request`。
5. Gateway 必须先得到一个完整、合法、受限的 wire JSON value，之后才进入 route conversion。Member
   order、number lexeme、missing/null/false/0/empty 的处理继续由 Wire JSON module 与对应协议规范
   决定。
6. 同一 request 同时具有多个错误时，除本文明确规定外不稳定其检查先后；contract tests 必须用单一
   fault 验证 presenter。

JSON request body 默认上限为 `32 MiB`，即 `33,554,432` bytes。当前 snapshot 上限值本身合法；读取第
`33,554,433` 个 byte 时必须停止处理，取消尚未完成的读取，并以 `body_too_large` 失败。不得截断后
继续 parse，也不得调用 upstream。

普通 JSON success 与所有 pre-commit error response 都必须设置：

```http
Content-Type: application/json; charset=utf-8
```

所有 error response 还必须设置：

```http
Cache-Control: no-store
```

Stream success 的 media type 与 exact bytes 由对应协议规范定义；stream request 在 pre-commit 失败
时仍返回普通 JSON，而不是 SSE/NDJSON error framing。

### 3.2 `anthropic-version`

`POST /v1/messages` 必须在 raw inbound headers 中恰好有一个大小写不敏感的
`anthropic-version` field，去除 HTTP optional whitespace 后其值必须恰好为：

```text
2023-06-01
```

Missing、empty、其他版本、重复 field 或由多个值合并而成的 field 都返回 Anthropic
`400 invalid_request_error`，且零 upstream call。该 header 只用于 inbound version validation，
不得转发到 Chat Completions upstream。

`GET /v1/models` 的规则有意不同：只要 `anthropic-version` header 存在，就选择 Anthropic success
serializer；不校验 value，empty、未知或合并 value 也只表示“存在”。它不改变任何 failure 的 status、
headers 或 body；model-list failure 始终使用 OpenAI model-list presenter。

## 4. Admission、limits 与 timeouts

本节数值是 runtime config defaults，不是 immutable constants。每个 request 在 admission 时捕获一个
immutable snapshot；同一 Stream Execution 不观察后续修改。Config keys、hard min/max 与 fixed
process capacities 由 [Master Spec](./specs/refactor_master_spec.md#72-config) 的 registry 定义。
本节所有 boundary assertions 同时适用于 default 和一个非默认合法 snapshot。

### 4.1 Inference admission

四个 inference `POST` route 共用一个 process-wide admission gate：

| Resource | Default |
| --- | ---: |
| Active inference requests | 4 |
| Queued inference requests | 16 |
| Maximum queue wait | 30 seconds |

- Active slot 覆盖一次 inference execution 的完整生命周期，包括 non-stream response 完成或 stream
  结束、失败、timeout、client abort。
- 在默认配置下，第 5 个到第 20 个尚未取得 slot 的 request 可以等待；已有 16 个 waiter 时，新 request 立即
  `queue_full`。
- Waiter 自进入 queue 起等待达到 captured `timeouts.queueMs` 仍未取得 slot 时为 `queue_timeout`。它是 overload，不是
  upstream timeout。
- Client abort 必须从 queue 移除 waiter、释放 listener/timer，并产生零 response bytes。
- Active request 完成、失败或 abort 后必须恰好释放一次 slot。
- 本文不规定 FIFO、LIFO 或跨协议公平性；实现不得让该内部选择改变容量、30 秒期限或 abort 语义。

Overload wire behavior：

| Route family | `queue_full` / `queue_timeout` status | Error type/shape |
| --- | ---: | --- |
| OpenAI Chat / Responses | 503 | `api_error` |
| Anthropic Messages | 529 | `overloaded_error` |
| Ollama Chat | 503 | `{"error":"server overloaded"}` |

这些都是 local、非 429 failure。即使 gateway 能估计等待时间，也不得生成 `Retry-After`。

Model-list routes 不消费 inference slot；它们的 account binding、model fetch、cache、cancellation
与错误完全服从 model listing 规范。

### 4.2 Buffer limits

| Buffer | Default maximum |
| --- | ---: |
| JSON request body | 32 MiB |
| Single upstream SSE event | 4 MiB |
| Upstream non-stream body | 32 MiB |
| Per-request protocol accumulator | 32 MiB |

所有上限均为 inclusive。Inbound 不支持压缩，request limit 按收到的 body bytes 计数；upstream
limit 按 transport 解码后交给 protocol layer 的 bytes 计数。超限必须立即失败、停止继续积累并取消
相应 upstream body；不得截断、丢 event 后继续，或返回部分成功。

- Request body 超限按各协议的 request presenter 处理。
- 在 downstream commit 前发现 upstream SSE event、non-stream body 或 protocol accumulator 超限，
  对 OpenAI/Anthropic 属于 invalid upstream response；Ollama 必须使用其生产规范对应的
  `upstream_stream_error`、`upstream_invalid_response` 等分类，不得被通用名称覆盖。
- 在 downstream commit 后发现 stream event 或 accumulator 超限，按第 5.2 节的 protocol-local
  post-commit behavior 处理，不能改写已经发送的 HTTP status。
- Model-list CAPI non-stream body 也受 32 MiB 上限约束；超限按 model listing 规范的 CAPI
  parse/fetch failure，以 model-list presenter 返回 502。

单个 SSE event 上限针对 framer 在一个 event boundary 内必须保留的全部 bytes；byte split、CRLF/LF、
多个 `data:` line 或 multibyte UTF-8 不能绕过限制。Protocol accumulator 指为生成当前 protocol
terminal/history 所保留的 request-local aggregate，不允许通过分片形成无界内存。

### 4.3 Inference timeouts

| Timer | Default | Failure |
| --- | ---: | --- |
| Upstream connect | 30 seconds | `upstream_timeout` |
| Upstream first byte | 120 seconds | `upstream_timeout` |
| Upstream stream idle | 120 seconds | `upstream_timeout` |
| Active inference total | 30 minutes | `upstream_timeout` |

- Connect timer 限制建立 upstream connection；即时 DNS、connection 或 TLS failure 是
  `upstream_network`，timer 到期才是 `upstream_timeout`。
- First-byte timer 要求 upstream 在期限内开始 response；它不能因先向 downstream commit SSE headers
  或 comment 而被规避。
- Stream idle timer 在每次收到 upstream body bytes 后重新计时。它只适用于尚未结束的 stream。
- Total timer 从 request 取得 active slot 并开始 execution 时计时，到完整 success、failure 或 abort
  为止；queue wait 使用独立的 30 秒期限。
- 任一 timer 触发都必须 abort 同一个 upstream operation并释放 timer、body、socket 与 active slot。
- Client abort 不是 timeout，并始终抑制新增 response bytes。

Model catalog transport 是明确例外：它继续使用 model listing 规范中的 30 秒 connect timeout 与
600 秒 total timeout，并按该规范映射为 model-list error；不得套用 inference 的 120 秒/30 分钟
presenter。

## 5. Response commit boundary

### 5.1 Pre-commit

Host 必须延迟 downstream commit，直到：

1. upstream HTTP status 已知；
2. 对 non-stream，完整 body 已在 32 MiB 内读取、解析并验证；
3. 对 stream，首个准备写出的 protocol payload 已通过必要 framing/validation；
4. 没有 parsing、admission、timeout、network、upstream status 或 conversion failure。

在第一个 downstream body byte 之前发生的任何 failure 都必须由相应 presenter 返回普通 JSON
response。即使 client 请求了 stream，也不得预先 flush `200`, SSE headers、SSE comment、空 event
或 NDJSON whitespace，导致后续只能在 stream 内报错。

### 5.2 Post-commit

HTTP status 与 headers 一旦 commit 不得替换。Transport、timeout、framing 或 conversion failure
遵守以下规则：

| Stream | Post-commit non-abort failure |
| --- | --- |
| OpenAI Chat | 关闭连接；不合成 `[DONE]` |
| Responses `ChatBridgePlan` | 关闭连接；不合成 `response.failed` 或其他 terminal |
| Responses `NativeResponsesPlan` | 关闭连接；不改写成 Chat bridge event，不合成 terminal |
| Anthropic Messages | 关闭连接；不合成 `event:error`、`message_delta` 或 `message_stop` |
| Ollama Chat | 按 Ollama 规范恰好追加一个安全 NDJSON error object并关闭；不再输出 `done:true` |

Ollama error line 是其生产规范明确要求的 stream error，不是 success terminal。所有协议在 client abort
后都直接关闭并写零个新增 bytes。

上表只处理 gateway/upstream failure。一个由对应协议定义且解析合法的 error event/object 是协议
内容，不得误分类：

- Native Responses 的 HTTP 2xx response，即使包含 `response.failed`、`status:"failed"` 或
  `type:"error"`，仍是合法 Responses success transport content，不得改为非 2xx HTTP error。
- Native stream 收到的合法 `response.failed` event 可以按 native 规范处理，但 gateway 不自行生成。
- `ChatBridgePlan` 在任何 failure path 都不得合成 `response.failed`。

## 6. Failure taxonomy

下表是语义分类，不是公开 DTO，也不要求内部使用相同 identifier：

| Failure | Definition | Pre-commit safe message |
| --- | --- | --- |
| `invalid_request` | empty/malformed/non-object JSON、schema 或 version validation failure | `invalid request` |
| `body_too_large` | inbound JSON body 超过 32 MiB | `request body too large` |
| `unsupported_media_type` | request `Content-Type` 不受支持 | `unsupported media type` |
| `unsupported_semantics` | source-valid request 无法由目标协议等价表达 | `unsupported semantics` |
| `authentication` | Bound Account/credential 不存在、无效或明确 authentication failure | `authentication failed` |
| `permission` | 明确 permission failure | `permission denied` |
| `model_not_found` | client 显式 model 不在 Bound Account captured catalog | `model not found` |
| `queue_full` / `queue_timeout` | local inference admission overload | `server overloaded` |
| `upstream_network` | DNS、connection、TLS 或其他非-timeout transport failure | `upstream request failed` |
| `upstream_timeout` | connect、first-byte、idle 或 total timer 到期 | `upstream timeout` |
| `upstream_http` | final upstream status 为 400–599 | `upstream request failed` |
| `invalid_upstream_response` | malformed/错型 2xx、超限 body/event/aggregate 或不合法 protocol data | `invalid upstream response` |
| `internal` | 未分类 gateway bug/failure | `internal error` |
| `aborted` | downstream client cancellation/disconnect | 无 response |

公开 message 必须使用表中的固定低信息文本或被引用的 Ollama/model-list 固定文本，不能拼接 exception、
URL、header、upstream body、request content 或 tool content。

## 7. Protocol error presenters

### 7.1 OpenAI Chat 与 Responses

所有 pre-commit error body 恰好使用：

```json
{
  "error": {
    "message": "<safe message>",
    "type": "<error type>",
    "param": null,
    "code": null
  }
}
```

最终 status 决定 `type`：

| Final HTTP status | `error.type` |
| ---: | --- |
| 400, 409, 413, 415, 422 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 429 | `rate_limit_error` |
| 其他 | `api_error` |

Local mapping：

| Failure | Status | Type | Message |
| --- | ---: | --- | --- |
| `invalid_request` | 400 | `invalid_request_error` | `invalid request` |
| `body_too_large` | 413 | `invalid_request_error` | `request body too large` |
| `unsupported_media_type` | 415 | `invalid_request_error` | `unsupported media type` |
| `unsupported_semantics` | 422 | `invalid_request_error` | `unsupported semantics` |
| `authentication` | 401 | `authentication_error` | `authentication failed` |
| `permission` | 403 | `permission_error` | `permission denied` |
| `model_not_found` | 404 | `not_found_error` | `model not found` |
| `queue_full` / `queue_timeout` | 503 | `api_error` | `server overloaded` |
| `upstream_network` | 502 | `api_error` | `upstream request failed` |
| `upstream_timeout` | 504 | `api_error` | `upstream timeout` |
| `invalid_upstream_response` | 502 | `api_error` | `invalid upstream response` |
| `internal` | 500 | `api_error` | `internal error` |

Final upstream 400–599 status 必须原样保留，但 body 必须安全重建为上述 envelope：

- `type` 只按 final status table 选择；
- `message` 固定为 `upstream request failed`；
- `param` 与 `code` 都为 JSON null；
- 不透传 upstream error object、headers 或 body。

Exact invalid-request example（JSON whitespace 不具有语义）：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
x-request-id: req_01example

{"error":{"message":"invalid request","type":"invalid_request_error","param":null,"code":null}}
```

Exact local overload example；不得带 `Retry-After`：

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
x-request-id: req_02example

{"error":{"message":"server overloaded","type":"api_error","param":null,"code":null}}
```

Exact safe rebuild of an upstream 429 with one valid delta-seconds：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Retry-After: 120
x-request-id: req_03example

{"error":{"message":"upstream request failed","type":"rate_limit_error","param":null,"code":null}}
```

### 7.2 Anthropic Messages

每个 pre-commit error body 恰好使用：

```json
{
  "type": "error",
  "error": {
    "type": "<error type>",
    "message": "<safe message>"
  },
  "request_id": "req_..."
}
```

Response `request-id` header 必须与 body `request_id` 完全相同。

Local mapping：

| Failure | Status | `error.type` | Message |
| --- | ---: | --- | --- |
| `invalid_request`，含缺失/错误/重复 `anthropic-version` | 400 | `invalid_request_error` | `invalid request` |
| `body_too_large` | 413 | `request_too_large` | `request body too large` |
| `unsupported_media_type` | 415 | `invalid_request_error` | `unsupported media type` |
| `unsupported_semantics` | 400 | `invalid_request_error` | `unsupported semantics` |
| `authentication` | 401 | `authentication_error` | `authentication failed` |
| `permission` | 403 | `permission_error` | `permission denied` |
| `model_not_found` | 404 | `not_found_error` | `model not found` |
| `queue_full` / `queue_timeout` | 529 | `overloaded_error` | `server overloaded` |
| `upstream_network` | 502 | `api_error` | `upstream request failed` |
| `upstream_timeout` | 504 | `timeout_error` | `upstream timeout` |
| `invalid_upstream_response` | 502 | `api_error` | `invalid upstream response` |
| `internal` | 500 | `api_error` | `internal error` |

Final upstream 400–599 status 必须原样保留、安全重建，并按下表选择 type；未列出的 status 使用
`api_error`：

| Final upstream status | `error.type` |
| ---: | --- |
| 400, 415, 422 | `invalid_request_error` |
| 401 | `authentication_error` |
| 402 | `billing_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 504 | `timeout_error` |
| 529 | `overloaded_error` |
| 500, 502, 503 及其他未列出 status | `api_error` |

Upstream safe-rebuild message 固定为 `upstream request failed`。不得把 upstream Anthropic error body
原样返回。

Exact invalid-version example：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
request-id: req_04example

{"type":"error","error":{"type":"invalid_request_error","message":"invalid request"},"request_id":"req_04example"}
```

Exact local overload example；不得带 `Retry-After`：

```http
HTTP/1.1 529
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
request-id: req_05example

{"type":"error","error":{"type":"overloaded_error","message":"server overloaded"},"request_id":"req_05example"}
```

### 7.3 Ollama Chat

除本文明确增加的 local admission overload 外，`POST /api/chat` 的 request、upstream、stream 和
post-commit errors 必须逐项遵守
[Ollama 生产规范](./ollama_chat_to_chat_completions.md)第 9 节，不得套用 OpenAI 或 Anthropic
type。

规范表如下，作为 presenter 的完整引用：

| Ollama error | Status | Exact safe text |
| --- | ---: | --- |
| `invalid_request` | 400 | `invalid request` |
| `unsupported_semantics` | 422 | `unsupported semantics` |
| `upstream_http_error` | upstream 400–599 | `upstream request failed` |
| `upstream_timeout` | 504 | `upstream timeout` |
| `upstream_stream_error` | 502 | `upstream stream error` |
| `upstream_invalid_response` | 502 | `invalid upstream response` |
| `upstream_stream_truncated` | 502 | `upstream stream truncated` |
| `invalid_tool_arguments` | 502 | `invalid tool arguments` |
| `invalid_logprobs` | 502 | `invalid logprobs` |
| `internal_error` | 500 | `internal error` |
| Gateway `queue_full` / `queue_timeout` | 503 | `server overloaded` |

Host-level malformed/empty/non-object/schema、media type 和 request body limit 都必须在进入 converter 或
upstream 前作为 Ollama `invalid_request` 呈现；不得为 Ollama 发明 OpenAI error type。

Pre-commit body 只有 `error` string：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{"error":"invalid request"}
```

Post-commit non-abort stream failure 只追加一个以下形式的 NDJSON line，末尾恰好一个 LF，然后关闭：

```ndjson
{"error":"upstream stream error"}
```

该 line 后不得有 `done:true`。Client abort 不追加 error 或 terminal。Local overload 的 exact body 是：

```json
{"error":"server overloaded"}
```

### 7.4 Model-list routes

`GET /v1/models` 与 `GET /api/tags` 的 status、body 和 cancellation 必须引用
[model listing 生产规范](./github_copilot_model_listing_apis.md)第 11–12 节，而不是推理 presenter。

Status mapping：

| Condition | Status |
| --- | ---: |
| 无 Bound Account、账号不存在、credential 无效、token endpoint 明确 401 | 401 |
| Token refresh network/connect/TLS/timeout、其他 HTTP 或 parse failure | 502 |
| Final CAPI 401 或 403 | 保留 401 或 403 |
| Final CAPI 429 | 429 |
| Final CAPI 其他 4xx/5xx | 保留 upstream status |
| CAPI 3xx、network/connect/TLS/timeout | 502 |
| CAPI success body malformed、endpoint 无法构造 request | 502 |
| Internal failure | 500 |
| Client abort | 零 response bytes |

`/v1/models` exact error body：

```json
{
  "error": {
    "message": "Failed to list GitHub Copilot models",
    "type": "api_error",
    "param": null,
    "code": "502"
  }
}
```

- 401/403 的 `type` 为 `authentication_error`；
- 429 的 `type` 为 `rate_limit_error`；
- 其他 status 的 `type` 为 `api_error`；
- `code` 是 final status 的十进制 string，不是 null；
- `anthropic-version` presence 不改变此 error。

`/api/tags` exact error body：

```json
{"error":"Failed to list GitHub Copilot models"}
```

它使用同一 status mapping。两个 route 只有在 final CAPI status 为 429 且满足第 8 节时才透传
`Retry-After`。

## 8. `Retry-After`

公开 response 只有同时满足以下全部条件时才能包含 `Retry-After`：

1. final upstream response status 恰好为 429；
2. final response 中恰好有一个 `Retry-After` field value；
3. value 是 [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3) 合法的
   non-negative `delay-seconds` 或 `HTTP-date`。

满足时透传该合法 value。以下情况必须删除：

- final status 不是 429；
- missing、empty 或语法非法；
- duplicate field；
- 多值被 comma-merge，例如 `120, 240`；
- redirect/intermediate response 上存在，但 final response 不满足规则。

单个合法 `HTTP-date` 自身包含 weekday comma，不得被误判为 merged value。例如：

```http
Retry-After: Sun, 06 Nov 1994 08:49:37 GMT
```

Local admission 使用 503/529，不生成 `Retry-After`；其他 local failure 也不生成。不得从 body、rate-limit
header、queue depth 或估算 delay 合成该 header。

## 9. Request IDs

Gateway 必须在第 2.2 节每个 matched compatibility request 入口生成新的、不可由 client 控制的 opaque
request ID。第 2.3 节 probes 是明确例外。
Anthropic-visible ID 必须具有 `req_` prefix；其余内部编码不在本文中稳定化。

| Route family | Public exposure |
| --- | --- |
| OpenAI Chat / Responses | `x-request-id` response header |
| `/v1/models`，包括 Anthropic success serializer | `x-request-id` response header |
| Anthropic Messages | `request-id` response header；error body 的 `request_id` 与它完全相同 |
| Ollama Chat / Tags | 只在内部 scope 使用；不向 Ollama body 增加字段 |

- Success、pre-commit error 与已成功 commit 的 stream headers 使用该 request 自己的 ID。
- 入站 `x-request-id`、`request-id` 或其他 correlation ID 不得作为 gateway ID、不得原样 echo，也不得
  覆盖 outbound Copilot identity headers。
- Upstream 返回的 request ID 不得覆盖 gateway ID。
- Client 在 gateway 生成 ID 前就断开，或任何 abort 导致零 response 时，不为暴露 header 而额外写
  response。
- Request ID 可以进入脱敏日志，但不得成为 metrics 的无界 label，也不得编码 credential、
  endpoint、request/response/tool content。

## 10. 安全与信息披露

公开 error status、headers 和 body 必须能只由 failure category、final upstream status 与本地生成的
request ID 构造。任何公开 error 都不得包含：

- GitHub、Copilot、OpenAI 或 Anthropic credential；
- 完整 upstream endpoint、path、query 或 account metadata；
- upstream headers，唯一例外是第 8 节允许的 `Retry-After`；
- upstream request/response body 或 exception dump；
- client request/response content、messages、images、tool declaration、tool arguments 或 tool result；
- stack、filesystem path、SQLite content 或内部 DTO。

日志与 Operational Events 同样不得记录上述内容。允许的最小诊断字段是 sanitized category、protocol、
final status、gateway request ID、timing 与不能还原完整 endpoint 的脱敏 host label。

所有 error response 使用 `Cache-Control: no-store`。错误重建不得复制 upstream `Set-Cookie`、
authentication challenge、server identity 或 hop-by-hop headers。

## 11. Normative test matrix

实现至少必须使用 deterministic clock、timer、UUID/request-ID source 与 scripted upstream 覆盖：

| Area | Required cases | Required assertions |
| --- | --- | --- |
| Listener/routes | default `127.0.0.1:31400`、alternate valid port、non-loopback config、每条 method/path、禁止 aliases 与 trailing slash | host 固定 loopback、port snapshot 生效；无 gateway key 仍可到达 route；禁止 route 未注册 |
| Probes | version/health、ready/not-ready、missing account、performance degraded、wrong method/trailing slash | exact status/headers/compact body；no account/upstream/admission；package version equality |
| JSON parsing | empty、malformed、array/scalar/null root、schema failure、valid object | 零 upstream call；对应 presenter、status 与 safe body |
| Media type/encoding | `application/json`、UTF-8 parameter、missing/wrong/malformed/non-UTF-8；missing/identity/gzip/duplicate Content-Encoding | accepted forms 成功进入 route；其他按协议失败且不解压 |
| Anthropic version | exact value、missing、empty、wrong、duplicate/merged；models 上 arbitrary/empty presence | Messages 只接受恰好一个固定版本且不转发；models 只改变 success serializer |
| Model resolution | missing with valid/invalid/no preference；explicit visible/empty/wrong-type/unknown；catalog mutation after capture | missing uses only valid preference；explicit unknown 404；no silent fallback；one immutable resolved model |
| Body limit | `32 MiB` 与 `32 MiB + 1`，含 chunked byte splits | boundary accepted；超限不截断、零 upstream call、资源释放 |
| Admission | 4 active、16 queued、第 17 个 waiter、slot release、30 秒前后、queued abort | 容量、503/529 shapes、无 local `Retry-After`、slot/timer 恰好释放 |
| Timeouts | connect 30s、first byte 120s、idle 120s、total 30min、immediate network/TLS、abort | timeout 与 network 分类不同；pre-commit status 正确；post-commit 不改 status |
| Buffer limits | single SSE event 4 MiB/+1、non-stream 32 MiB/+1、accumulator 32 MiB/+1、任意 byte split | 不截断；pre-commit 502/协议 error；post-commit closure 符合第 5.2 节 |
| Commit | 每种 failure 在首 byte 前/后各一例 | pre-commit 一定是普通 JSON；不得提前 SSE commit；不得合成 terminal |
| OpenAI presenter | 所有 local rows；upstream 400–599，至少覆盖 400/401/403/404/409/413/415/422/429/500/529 | status preserved、type table、四个 envelope fields、`code:null` |
| Anthropic presenter | 所有 local rows；upstream 400/401/402/403/404/413/415/422/429/500/502/503/504/529/other | type table、header/body ID 相同、local unsupported 为 400 |
| Ollama presenter | 生产规范第 9 节所有 rows、post-commit error、admission overload、abort | exact safe string、一个 LF error line、无后续 `done:true` |
| Model errors | model spec 全部 status、OpenAI/Anthropic success selection、Ollama body | errors 不随 Anthropic header 改变；`code` 为 status string |
| Responses 2xx | native non-stream/stream 中合法 failed/error protocol content；bridge failure | 保持 2xx protocol content；bridge 不生成 `response.failed` |
| `Retry-After` | delta-seconds、HTTP-date、missing、empty、invalid、duplicate、merged、non-429、redirect-only、local overload | 只透传 final 429 的单个合法 value |
| Request IDs | concurrent requests、success/error/stream、client-supplied IDs、Anthropic body equality | server-generated、每请求唯一、入站值不可信、正确 header/body |
| Redaction | 在 credential、URL、headers、body、message 与 tool fields 植入 canary | response、log、event 均找不到 canary |
| Cancellation | queued、connecting、pre-first-byte、mid-stream、model fetch | abort 传播；零个新增 response bytes；无 timer/listener/body/socket leak |

Protocol success tests 还必须继续运行被引用生产规范要求的 Ollama Go-compatible byte golden、Anthropic
Python `json.dumps` SSE golden、OpenAI Chat ordered JSON/SSE terminal、Responses item lifecycle/sequence、
native item-ID normalization 和 model serializer fixtures。本文的 presenter tests 不替代 protocol success
tests。

## 12. 完成标准

实现只有同时满足以下条件才完成：

1. Route matrix 中每条 route 都通过 Fetch-level contract test 和 loopback integration test。
2. 四个 inference routes 共用规定容量与期限的 admission gate，但各自保留 protocol-local presenter
   与 stream terminal ownership。
3. 所有 request/upstream/accumulator limits 在 boundary 与 boundary + 1 byte 上可重复验证，且无
   truncation 或部分 success。
4. 所有 timeout 与 abort 都取消同一个 upstream operation，释放 slot、timer、listener、body 与
   socket；abort 不产生额外 wire bytes。
5. 所有 pre-commit failures 都是本文规定的普通 JSON；所有 post-commit failures 都符合第 5.2 节。
6. OpenAI/Anthropic SDK 能按其 native error class/header 读取 presenter；Ollama 与 model-list errors
   与各自固定生产规范一致。
7. `Retry-After`、request ID 和 redaction matrix 全部通过，且 fuzz/duplicate-header cases 不绕过
   validation。
8. 内部 failure DTO 可以被替换而不改变任何 golden；不存在公开的通用 `BridgeError` shape。
9. Conversion mapping 仍只有对应生产规范一份行为来源；本文未产生第二套 field mapping。

## 13. Primary sources

固定源码提交：

- [BerriAI/litellm@ae7e50f096a8722bad14d63b6a0d4634d59bf475](https://github.com/BerriAI/litellm/commit/ae7e50f096a8722bad14d63b6a0d4634d59bf475)
- [farion1231/cc-switch@3217f72596f2d1c0f879f0a05f83803825d9809f](https://github.com/farion1231/cc-switch/commit/3217f72596f2d1c0f879f0a05f83803825d9809f)
- [ollama/ollama@f96e7aa0513b9973a0ccc71be414c2ecb9d65b1a](https://github.com/ollama/ollama/commit/f96e7aa0513b9973a0ccc71be414c2ecb9d65b1a)

SDK compatibility references：

- [OpenAI Node SDK — handling errors](https://github.com/openai/openai-node#handling-errors)
- [OpenAI Node SDK — request IDs](https://github.com/openai/openai-node#request-ids)
- [Anthropic TypeScript SDK — handling errors](https://github.com/anthropics/anthropic-sdk-typescript#handling-errors)
- [Anthropic TypeScript SDK — request IDs](https://github.com/anthropics/anthropic-sdk-typescript#request-ids)

这些 SDK 链接用于验证 client compatibility；它们的 future drift 不得静默改变本文已经固定的 wire
contract。
