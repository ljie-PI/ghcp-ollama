# OpenAI Responses API → Chat Completions 桥接规范

> 状态：唯一生产行为规范；不保留目标仓库旧实现兼容分支
>
> 固定来源：request/input/history 采用 cc-switch
> `3217f72596f2d1c0f879f0a05f83803825d9809f`；response envelope、content、usage 与
> managed ID 采用 LiteLLM `ae7e50f096a8722bad14d63b6a0d4634d59bf475`；response tool
> restoration 与 stream item lifecycle 采用上述 cc-switch 提交

## 1. 范围与固定优先级

本文只定义
[OpenAI Responses 上游路由规范](./openai_responses_routing.md) 选择 `ChatBridgePlan` 后的行为。
`NativeResponsesPlan` 不调用本文 converters，也不读写本文 HistoryStore。

本文定义：

1. 已解析 Responses request object → Chat Completions request object；
2. Chat Completions response object → Responses response object；
3. typed Chat Completions async chunk sequence → Responses event sequence；
4. cc-switch request-side tool history enrichment。

实现只有一个生产 profile：

| 方向 | 规范来源 | 冲突处理 |
|---|---|---|
| request/input/tools/history | cc-switch | 与 LiteLLM 不同时采用 cc-switch |
| nonstream response | LiteLLM + cc-switch | LiteLLM envelope/content/usage/ID；cc-switch ToolContext restoration |
| streaming response | LiteLLM + cc-switch | LiteLLM response events；cc-switch ToolContext 与独立 item lifecycle |

`docs/cc-switch/codex_response_to_chat_completions.md` 和
`docs/litellm/codex_response_to_chat_completions.md` 是来源说明，不是运行时 profile。来源说明与固定
提交冲突时，以固定提交为准。

目标仓库已有 adapter、ID、error、SSE parser 和测试不参与行为选择；冲突的旧实现必须替换。

转换核心不接收原始 HTTP body 或 SSE bytes。宿主负责 JSON/SSE framing、压缩、body limit、
认证、重试和路由。本文 stream converter 接收上游已经解析的 typed Chat chunks。
首字节前的 HTTP limits、admission、timeout 和公开 errors 由
[Gateway HTTP contracts](./gateway_http_contracts.md) 定义。
Typed Responses events 的 downstream media type、`event:`/`data:` bytes、terminal 与 EOF behavior 由
[Responses 上游路由规范](./openai_responses_routing.md#75-downstream-responses-sse-wire) 定义。

## 2. 逻辑接口与上下文

```text
enrichResponsesHistory(
  request: ResponsesRequest,
  history: HistoryStore
) -> ResponsesRequest

convertResponsesRequest(
  request: ResponsesRequest,
  context: RequestContext
) -> ChatRequest | TransformError

convertChatResponse(
  response: ModelResponse | JsonObject,
  context: ResponseContext
) -> ResponsesResponse | TransformError

LiteLLMAsyncResponseStream(
  chunks: AsyncIterator<ChatChunk>,
  context: StreamContext
) -> AsyncIterator<ResponsesEvent>
```

```text
RequestContext {
  resolvedModel: string
  reasoningConfig: ReasoningConfig | null
  upstreamHost?: string
  upstreamPath?: string
  promptCacheRouting?: "enabled" | "disabled" | "auto"
  clientSessionId?: string
}

StreamContext {
  originalRequest: ResponsesRequest
  toolContext: RequestToolContext
  model: string
  customLlmProvider?: string
  modelId?: string
}

ResponseContext {
  originalRequest: ResponsesRequest
  toolContext: RequestToolContext
  customLlmProvider?: string
  modelId?: string
}
```

Defaults：

```text
thinkingParam   = "thinking"
effortParam     = "reasoning_effort"
effortValueMode = "passthrough"
```

不存在通用 `Capabilities`、`ConversionOptions.behavior_profile`、`Diagnostic` 或稳定
`BridgeError` DTO。请求和响应各自使用其来源实现实际需要的状态，不强制共享一个 context。
进入 `convertResponsesRequest` 前必须完成 model selection；`request.model` 与
`RequestContext.resolvedModel` 必须相同。转换器不读取 provider catalog 或默认 model。

## 3. Request 预处理

执行顺序：

1. 保存客户端显式 `prompt_cache_key`；
2. 用 `previous_response_id` 和 input call IDs 做历史 enrichment；
3. 应用 [上游路由规范](./openai_responses_routing.md) planning 前唯一解析的 upstream model，并同时
   写入 request 与 `RequestContext.resolvedModel`；
4. 从顶层 `tools[]` 和 `tool_search_output.tools[]` 构造 request-side `ToolContext`；
5. 接收调用方已经解析完成的 `ReasoningConfig | null`；
6. 转换 request body；
7. 按本节规则注入 prompt cache key。

### 3.1 ToolContext

```text
RequestToolContext {
  chatTools: ChatTool[]
  seenChatNames: Set<string>
  chatNameToBinding: Map<string, {
    kind: "function" | "namespace" | "custom" | "tool_search"
    originalName: string
    namespace?: string
  }>
  sourceNameToChatName: Map<(namespace?, originalName), string>
}
```

收集来源：

1. request 顶层 `tools[]`；
2. 递归遍历整个 `input`，收集任意 `tool_search_output.tools[]`。

Function/custom/namespace child name 在判断前执行 `trim()`；空 name 和重复最终 Chat name 被跳过，
先出现的定义获胜。Namespace 自身 name 保持 source string。Request、nonstream response 和 stream
response 分别从同一个 immutable original request 构造等价 context；不要求复用同一 object instance。

### 3.2 Model 与 prompt cache key

`ChatBridgePlan` 只消费
[上游路由规范](./openai_responses_routing.md) planning 前得到的唯一 `ResolvedModel`：

1. 不再次查询 catalog 或默认 model；
2. 将 `ResolvedModel.upstreamModel` 写入 request 与 `RequestContext.resolvedModel`；
3. 再执行 request 转换。

默认允许 `prompt_cache_key` 的上游：

- host 为 `api.openai.com`；
- host 为 `api.kimi.com`，且 path 为 `/coding` 或以 `/coding/` 开头。

`promptCacheRouting`：

- `enabled`：允许；
- `disabled`：禁止；
- `auto` 或缺失：使用 host/path 规则。

允许时 key 优先级：

1. 客户端显式 `prompt_cache_key` 执行 `trim()` 后的非空值；
2. 客户端提供的 `clientSessionId` 执行 `trim()` 后的非空值；
3. 不写入。

代理生成的逐请求 UUID 不能作为 cache key。

## 4. Request 顶层字段

### 4.1 映射

| Responses request | Chat request | 规则 |
|---|---|---|
| `model` | `model` | 预处理后的值 |
| `instructions` | 首条 system message | 见第 4.2 节 |
| `input` | `messages` | 见第 5 节 |
| `max_output_tokens` | `max_completion_tokens` / `max_tokens` | raw model 以小写 `o` 开头且第二字符是 ASCII digit 时使用前者 |
| `max_tokens` | `max_tokens` | 原值；覆盖前一步同名值 |
| `max_completion_tokens` | `max_completion_tokens` | 原值 |
| `temperature` | 同名 | 原值 |
| `top_p` | 同名 | 原值 |
| `stream` | 同名 | 原值 |
| `reasoning` | provider 方言字段 | 第 7 节 |
| `tools` | `tools` | 第 6 节 |
| `tool_choice` | `tool_choice` | 第 6.5 节 |

以下字段原值透传：

```text
frequency_penalty
logit_bias
logprobs
metadata
n
parallel_tool_calls
presence_penalty
response_format
seed
service_tier
stop
stream_options
top_logprobs
user
```

未列出的字段被丢弃，包括：

```text
previous_response_id
store
include
truncation
text
prompt_cache_key
```

`text.format`、`text.verbosity` 和 structured-output shortcut 均不转换。客户端显式顶层
`response_format` 仍按透传表进入 Chat request。

最终没有非空 tools 时删除 `tool_choice` 和 `parallel_tool_calls`。

只有 `stream` 为 JSON boolean `true` 时才保证：

```json
{"stream_options":{"include_usage":true}}
```

原 `stream_options` 为 object 时保留其他键并覆盖 `include_usage:true`；其他类型替换为上述 object。

### 4.2 Instructions 与 system

`instructions`：

- string：直接生成 system message；
- array：每项若为 string 则取自身，否则取 string `.text`；过滤空 string 后用 `\n\n` 连接；
- 其他：不生成。

全部 input 转换完成后，把所有 system message 的非空 string content 按原出现顺序用 `\n\n`
连接并移动到 `messages[0]`。其他消息相对顺序不变。

## 5. `input` → `messages`

### 5.1 Input shape 与 role

`input`：

- string → 单条 user message；
- object → 单个 input item；
- array → 按顺序处理；
- 其他 → 不生成 message。

| Responses role | Chat role |
|---|---|
| `system` / `developer` | `system` |
| `assistant` | `assistant` |
| `tool` | `tool` |
| `user` / `latest_reminder` | `user` |
| 其他或缺失 | `user` |

### 5.2 Message 与 content parts

`type=="message"`，或 type 缺失但有 `role`/`content` 的 object，按普通 message 转换。未知 type
只要有 `role` 或 `content` 也按 message 处理。

Content：

- null 或 string：原样；
- 非 array、非 string：原样；
- array：逐 part 转换。

| Responses part | Chat part |
|---|---|
| `input_text` / `output_text` / `text` | `.text` 为非空 string 时生成 `{"type":"text","text":...}`，否则丢弃 |
| `refusal` | `.refusal` 为非空 string 时按 text part 处理，否则丢弃 |
| `input_image` | `{"type":"image_url","image_url":...}` |
| `input_file` | `{"type":"file","file":{...}}` |
| `input_audio` | `{"type":"input_audio","input_audio":...}` |
| 其他 | 丢弃 |

Image：

- `image_url` 为 object 时原样复制；
- 其他值变为 `{"url": <string-or-empty>}`。

File 只复制 `file_id`、`file_data`、`filename`；必须至少有 `file_id` 或 `file_data`，URL-only file
被丢弃。Audio 只在 `input_audio` 存在时复制。

没有任何非文本 part 时，把 text 使用单个 `\n` 连接为 string；有 image/file/audio 时保留 parts
array。

顶层 `input_text`、`input_image`、`input_file`、`input_audio` item 视为单 part message。

### 5.3 Call batching

连续 call items 合并为一条：

```json
{"role":"assistant","content":null,"tool_calls":[]}
```

request-side tool call 不写 `index`。

`function_call`：

```text
id = call_id -> item.id -> ""
function.name = RequestToolContext 映射后的 name
function.arguments = normalized JSON string
```

`custom_tool_call`：

```text
id = call_id -> item.id -> ""
function.name = item.name -> ""
function.arguments = canonical JSON {"input": item.input or ""}
```

`tool_search_call`：

```text
id = call_id -> item.id -> ""
function.name = "tool_search"
function.arguments = canonical JSON of item.arguments; missing -> "{}"
```

`function_call_output` 生成 tool message，content 规则：

- string 且可 JSON parse：parse 后 canonicalize；
- 其他 string：原样；
- 其他 JSON：canonical JSON；
- 缺失：空 string。

`custom_tool_call_output` 和 `tool_search_output` 的 content 是替换媒体后的**完整原始 item**
canonical JSON，不只是 `.output`。

### 5.4 Canonical JSON

1. object key 在每层按字典序；
2. array 保序；
3. compact JSON，无多余 whitespace；
4. 递归处理；
5. string/number/null/bool 输出匹配 `serde_json::Value` serializer。

Arguments normalization：

- missing、空或全 whitespace string → `"{}"`；
- 可 parse 的 JSON string → parse 后 canonicalize；
- 无法 parse 的 string → 原样；
- object/array/scalar → canonical JSON string。

### 5.5 Reasoning history

普通或 call item reasoning 提取优先级：

1. 非空 `reasoning_content` string；
2. 非空 `reasoning` string；
3. `reasoning.content`、`.text`、`.summary`；
4. `reasoning_details` string/object/parts，parts 用 `\n\n` 连接。

独立 `type=="reasoning"` item：

1. `reasoning_content`、`content`、`text`；
2. `summary` string；
3. `summary[]` 中 `.text`、`.content` 或 string part，用 `\n\n` 连接。

状态：

1. 独立 reasoning 进入 pending；
2. 后续 assistant message/call batch 消费；
3. 多段用 `\n\n` 连接；
4. call 自带重复文本不再次追加；
5. user 等非-assistant 边界前，把 pending 回填到上一 assistant；
6. input 结束同样回填；
7. 有 tool calls 但无非空 reasoning 的 assistant 最终补 `reasoning_content:"tool call"`。

### 5.6 Tool-output media

递归扫描最大深度 32。媒体位置替换为：

```text
[cc-switch: tool result media moved to the following user message]
```

并在当前并行 outputs 后生成 synthetic user message，每个 call 的媒体前加入：

```text
[cc-switch: media output of tool call <call_id>]
```

支持：

- Responses/Chat image URL；
- Anthropic base64 image；
- MCP image；
- 含 `file_id` 或 `file_data` 的 `input_file`；
- `input_audio.input_audio`；
- trim 后至少 8 KiB、整个 string 都是 image data URL；
- JSON 编码 string 内的上述结构。

不扫描 HTML/CSS/SVG 内嵌 data URL。只有确实找到媒体后，残留超长 data/base64-like string
替换为：

```text
[cc-switch: omitted <byte_len> bytes]
```

## 6. Tool declarations

### 6.1 Function

接受平铺或嵌套 function shape，统一为 Chat function tool。Parameters：

- missing、null、非-object → `{"type":"object","properties":{}}`；
- object 且 `.type` 不是 string `"object"` → 保留其他 keys，强制 `type:"object"`；
- 保留顶层 `oneOf` 等其他 schema keys；
- 嵌套 function 的 `strict` 优先，否则使用 tool 顶层 `strict`。

### 6.2 Namespace

Namespace child 数组接受 `tools` 或 `children`，只处理 `type=="function"` child。

最终 Chat name：

```text
namespace + "__" + childName
```

若 UTF-8 长度超过 64 bytes：

1. SHA-256 完整 name；
2. 取 digest 前 8 bytes，编码 16 个小写 hex；
3. suffix 为 `"__" + hex`；
4. 取不切断 UTF-8 code point 的最长前缀，使总长度不超过 64 bytes。

### 6.3 Custom 与 tool search

String tool declaration 也视为 custom。Custom 固定转换为：

```json
{
  "type": "function",
  "function": {
    "name": "<trimmed-name>",
    "description": "Original tool definition:\n```json\n<canonical-original-tool>\n```",
    "parameters": {
      "type": "object",
      "properties": {
        "input": {
          "type": "string",
          "description": "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description."
        }
      },
      "required": ["input"]
    }
  }
}
```

Tool search 固定降级为 name `tool_search` 的 function：

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type":"string",
      "description":"Search query for tools or connectors to load."
    },
    "limit": {
      "type":"integer",
      "description":"Maximum number of tool groups to return."
    }
  },
  "required": ["query"]
}
```

Tool-search function description 固定为：

```text
Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.
```

只转换 function、namespace、custom 和 tool_search；其他 tool type 被忽略。

### 6.4 Collision

所有最终 Chat names 共用一个 first-wins set。后来的重复 name 被跳过。Namespace tool choice 使用
RequestToolContext 中实际生成的 name，不能重新计算另一个 hash。

### 6.5 `tool_choice`

| Responses value | Chat value |
|---|---|
| `{"type":"function","name":"f","namespace":"ns"?}` | 指定映射后的 function |
| `{"type":"tool_search"}` | 指定 `tool_search` function |
| `{"type":"custom","name":"x"}` | 指定 `x` function |
| 其他 string/object | 原样 |

最终 tools 为空时删除整个 `tool_choice`，包括 string `"none"`。

## 7. Reasoning request

```text
ReasoningConfig {
  supportsThinking?: bool
  supportsEffort?: bool
  thinkingParam?: "thinking" | "enable_thinking" | "reasoning_split" | "none"
  effortParam?: "reasoning_effort" | "reasoning.effort" | "none"
  effortValueMode?: "passthrough" | "deepseek" | "low_high" | "openrouter" | "zen"
  effortLevels?: string[]
}
```

Requested state：

- `reasoning.effort` trim/lowercase 为 `none`、`off`、`disabled` → false；
- 其他 string effort → true；
- 否则有 `reasoning` key 时，非-null → true，null → false；
- 无 `reasoning` key → unspecified。

Thinking switch：

| `thinkingParam` | true | false |
|---|---|---|
| `thinking` | `{"thinking":{"type":"enabled"}}` | `{"thinking":{"type":"disabled"}}` |
| `enable_thinking` | `true` | `false` |
| `reasoning_split` | `true` | `false` |
| none/其他 | 不写 | 不写 |

`supportsEffort=true` 时始终视为支持 thinking，即使 `supportsThinking` 明确为 false。

只有 requested=true 且支持 effort 时映射：

| mode | 映射 |
|---|---|
| `passthrough` | 仅 `minimal/low/medium/high/xhigh/max/ultra` |
| `deepseek` | `max/xhigh/ultra -> max`；其他任何非 disabled string → `high` |
| `low_high` | `minimal/low -> low`；其他任何非 disabled string → `high` |
| `openrouter` | `max/xhigh/ultra -> xhigh`；其他只接受 `high/medium/low/minimal` |
| `zen` | 在 `effortLevels` 选择不低于请求的最近值；超过最高取最高 |

档位顺序：

```text
minimal < low < medium < high < xhigh < max < ultra
```

`effortParam=="reasoning_effort"` 写顶层；`"reasoning.effort"` 写 nested object。显式关闭时只有
nested 方言写 `{"reasoning":{"effort":"none"}}`。

无 provider config 时，只对 cc-switch 内置判断支持 effort 的 model，把
`reasoning.effort` 原值写到顶层 `reasoning_effort`。`reasoning.summary` 被忽略。

Provider/model → `ReasoningConfig` 的推导属于 model routing，不属于协议转换器。调用方必须在每次
request 进入转换器前解析成 explicit config 或 null；转换器不得再次读取 provider name、base URL、
model catalog 或目标仓库全局配置。

## 8. Request history

HistoryStore：

- 最多 512 个 response，按插入顺序淘汰；
- 默认 TTL 为 7 天，可由 runtime config 修改；
- TTL 从 response 首次记录时间计算，不因 lookup 滑动；
- 启动、lookup 和 record 前清理过期 response；过期项不参与 scoped lookup 或全局唯一 fallback；
- TTL 缩短时立即按首次记录时间清理现有数据；延长不能恢复已删除数据；
- 每个 response 保存有序 call items 和 `call_id -> item`；
- 全局保存 `call_id -> response IDs`；
- 只缓存 `function_call`、`custom_tool_call`、`tool_search_call`；
- call ID 取 trim 后非空 `call_id`，否则 `id`。

Lookup：

1. 先查 `previous_response_id`；
2. 未命中的 call ID 仅在全局恰好匹配一个 response 时 fallback；
3. 多个 response 有同一 call ID 时不猜。

Enrichment：

- output 前缺 call item：按原顺序插入匹配组；
- 后续单个 output 缺 call：在其前插入 cached call；
- 已有 call 不重复；
- 已有 call 的空字段可从 cache 补 `name`、`namespace`、`arguments`、`input`、`status`、
  `execution`、`reasoning_content`、`reasoning`；
- request 非空字段始终优先。

原 input 是单 object 且未变化时保持 object；发生恢复后可变为 array。

非流成功后从完整 Responses response 记录。流式路径把每个已转换
`response.output_item.done` 视为 Semantic Checkpoint，在向客户端发送该 event 前同步提交 minimal
history；`response.completed` 前提交最终 response state。未完成的 delta/fragments 不记录。由于
响应采用 LiteLLM，能记录的类型受第 12 节组合损失限制。

## 9. 非流式 Chat response

### 9.1 输入、envelope 与 status

接受 LiteLLM `ModelResponse` 或可构造成该类型的 object。空 choices 不报错：finish reason 为
null，status 为 completed，output 为空。

| Chat/source | Responses field | 规则 |
|---|---|---|
| `id` | `id` | 先复制，再由 managed-ID helper 编码 |
| `created` | `created_at` | 原值 |
| `model` | `model` | 原值 |
| fixed | `object` | `"response"` |
| `error` | `error` | 存在时复制，否则 null |
| `incomplete_details` | `incomplete_details` | 存在时复制，否则 null |
| `instructions` | `instructions` | 存在时复制，否则 null |
| `metadata` | `metadata` | 存在时复制，否则 `{}` |
| `parallel_tool_calls` | `parallel_tool_calls` | 存在时复制，否则 false |
| `temperature` | `temperature` | 存在时复制，否则 0 |
| `tool_choice` | `tool_choice` | 存在时复制，否则 `"auto"` |
| `tools` | `tools` | 存在时复制，否则 `[]` |
| `top_p` | `top_p` | 存在时复制，否则 null |
| `max_output_tokens` | `max_output_tokens` | 存在时复制，否则 null |
| `previous_response_id` | `previous_response_id` | 存在时复制，否则 null |
| fixed | `reasoning` | null |
| fixed | `text` | `{}` |
| `truncation` | `truncation` | 存在时复制，否则 null |
| `user` | `user` | 存在时复制，否则 null |
| `usage` | `usage` | 第 10 节 |

顶层 status 只取 first choice：

| finish_reason | status |
|---|---|
| `stop` / `tool_calls` / `function_call` / null | `completed` |
| `length` / `content_filter` / `refusal` | `incomplete` |
| 其他 | `completed` |

`length` 不生成 synthesized `incomplete_details`。

### 9.2 Output 顺序与 IDs

1. 最多一个 reasoning item；
2. 每个 choice 的 message item或 image-generation items；
3. 所有 choices 的 function/custom call items；
4. provider server-side tool result 可替换同 call ID function item。

IDs：

| Item | ID |
|---|---|
| message | `msg_` + UUID4 |
| reasoning | `rs_` + UUID4 |
| image generation | `ig_` + UUID4 |
| function/custom call | Chat tool-call ID 同时作为 `id`、`call_id` |

UUID4 使用小写 hex 与标准 hyphen，每次转换新生成。Nonstream response 构造完成后调用第 11.1 节
managed-ID helper；missing ID 与已是 managed ID 的值保持不变。

### 9.3 Reasoning、message、annotations

只检查第一个有 reasoning 的 choice，生成最多一个 reasoning item：

- 明文只读 `message.reasoning_content`；
- 带 `signature` 或 `data` 的 thinking blocks compact-JSON 编码到 `encrypted_content`；
- 没有明文但有可保留 block 时 content 为空 array；
- item status 由该 choice finish reason 映射。

每个没有 `message.images` 的 choice 生成一个 message item：

```json
{
  "type": "message",
  "id": "msg_<uuid4>",
  "status": "<mapped>",
  "role": "<Chat message role>",
  "content": [{
    "type": "output_text",
    "text": "<message.content>",
    "annotations": []
  }]
}
```

只转换 message-level annotation `type=="url_citation"`，复制
`start_index`、`end_index`、`url`、`title`。其他 annotations 删除。Refusal parts、
`<think>` tag、`message.reasoning` 和 legacy `function_call` 不转换。

### 9.4 Tool calls

收集所有 choices 的 typed `message.tool_calls[]`。对每个 call，先按 Chat function name 查询
`ResponseContext.toolContext.chatNameToBinding`。

未命中或 kind=`function` 时生成普通 call：

```json
{
  "type": "function_call",
  "id": "<Chat call id>",
  "call_id": "<Chat call id>",
  "name": "<Chat function name>",
  "arguments": "<raw arguments string>",
  "status": "<function status or completed>"
}
```

不 canonicalize arguments，不生成缺失 call ID，不要求 name 非空。

Kind=`namespace` 时生成普通 `function_call`，`name=binding.originalName`，并写入
`namespace=binding.namespace`。

Kind=`custom` 时生成：

```text
id      = Chat call ID
call_id = Chat call ID
type    = "custom_tool_call"
name    = binding.originalName
status  = function.status or "completed"
input:
  arguments trim 后为空                -> ""
  arguments parse 为 object 且 input 是 string -> object.input
  其他                                  -> 原 arguments string
```

Kind=`tool_search` 时生成：

```text
type      = "tool_search_call"
call_id   = Chat call ID
status    = function.status or "completed"
execution = "client"
arguments:
  空 string                    -> {}
  可 parse 为 JSON object       -> parsed object
  其他                          -> {"query": <raw arguments>}
```

只有普通 function call 附加 `provider_specific_fields`；custom call 不附加。优先使用 tool-call
外层 truthy 值，缺失或 falsy 时再使用 function 内层 truthy 值。Provider
`code_interpreter_results` 可按 call ID 替换普通 function item。

### 9.5 Images

Choice message 有 `images` 时，该 choice 不生成 text message；每个有效 image：

```json
{
  "type": "image_generation_call",
  "id": "ig_<uuid4>",
  "status": "completed|incomplete|failed",
  "result": "<base64>"
}
```

任意 nonempty string 以 `data:` 开头时，在第一个 comma 处分割并取后半；没有 comma 时丢弃该
image。非 `data:` string 原样作为 result，不验证是否为 base64。

| finish reason | image status |
|---|---|
| `stop` | completed |
| `length` | incomplete |
| `content_filter` / `error` | failed |
| 其他 | completed |

## 10. Usage 与 provider fields

| Chat usage | Responses usage |
|---|---|
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `total_tokens` | `total_tokens` |
| `cost` | dynamic `cost` |

Usage 缺失时三个 token count 均为 0。

`prompt_tokens_details` 存在时创建 `input_tokens_details`：

- `cached_tokens`，缺失补 0；
- `text_tokens`；
- `audio_tokens`；
- `cache_write_tokens` 为 truthy 时使用；否则（包括 0）用 `cache_creation_tokens` fallback。

`completion_tokens_details` 存在时创建 `output_tokens_details`：

- `reasoning_tokens`，缺失补 0；
- `audio_tokens`；
- `text_tokens`；
- `image_tokens`。

Chat `_hidden_params` 整体复制。若其中有 `provider_specific_fields`，还暴露同名顶层动态字段。

## 11. Streaming Chat response

### 11.1 Boundary 与 initial response

只定义 LiteLLM async iterator。它接收 typed Chat chunks；raw `data:`、`[DONE]`、malformed JSON、
UTF-8 residual 和 transport framing 都由宿主处理。

发出 `response.created` 前先读取字面上的第一个 non-null chunk：

- 有 string chunk ID：缓存为原始 response ID；
- iterator 先结束：生成 `resp_<uuid4>`。

该 chunk 被 buffer，并在初始 response events 发出后进入正常语义转换。Output item 必须等到第一个 nonempty
reasoning/text delta 或具有可用 call ID/name 的 tool delta 才创建。Role-only、blank 和
usage-only chunk 不创建 output item。

Response-level stream ID 编码：

```text
resp_<base64(
  "litellm:custom_llm_provider:<provider>;"
  + "model_id:<model-id>;"
  + "response_id:<original-id>"
)>
```

使用 UTF-8 与普通 RFC 4648 padded Base64，不使用 URL-safe alphabet。`model-id` 来自
`StreamContext.modelId`；`provider` 或 `model-id` 缺失时按 Python `str(None)` 写成
`"None"`。已经可解码为 LiteLLM managed ID 时不重复编码。`response.created`、`response.in_progress` 和
`response.completed` 使用编码 ID。Nonstream core 构造 response 后，public converter 对同一对象调用
该 helper；response ID missing 时 helper 原样返回。

本转换 seam 把 LiteLLM metadata 限定为 `modelId`，不启用
`encrypted_content_affinity_enabled`，也不执行 container-ID rewrite；这些属于 LiteLLM router/
container framework，而不是本协议转换。

`response.created.response` 初始字段：

```text
id                 cached raw ID, then encoded in event
object             "response"
created_at         current Unix seconds
status             "in_progress"
error              null
incomplete_details null
instructions       original request value or null
max_output_tokens  null
model              StreamContext.model
output             []
parallel_tool_calls true
previous_response_id null
reasoning          {effort:null, summary:null}
store              true
tool_choice        transformed original value or "auto"
tools              original request tools or []
top_p              original value or 1.0
```

存在时还复制 original request 的 `temperature`、`text`、`truncation`、`user`、`metadata`。

最先依次发送：

```text
response.created
response.in_progress
```

### 11.2 Text

第一个 nonempty text delta 创建 message item与 content part。普通 text 事件：

```text
response.output_item.added
response.content_part.added
response.output_text.delta repeated
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Message 使用分配到的 `output_index`、`content_index=0`，ID 为本次 stream 缓存的
`msg_<uuid4>`。Incremental text 只读取 first choice `delta.content`。Reasoning 已结束后首次出现
text 时必须先发送 message `output_item.added` 和 `content_part.added`。

Stream 维护 `next_output_index=0`。每个 reasoning、message 或 tool 首次 added 时取得当前值并将其
递增；同一 item 后续所有 events复用该 index。

### 11.3 Reasoning

首个 nonempty `reasoning_content` 打开独立 `rs_<uuid4>` reasoning item并分配 output index。每段发：

```text
response.reasoning_summary_part.added  // 仅 item 首次打开时
response.reasoning_summary_text.delta
```

首次看到普通 content、function/tool call 或非-null finish reason 时依次发：

```text
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done
```

Reasoning 文本为所有已见 `reasoning_content` 直接拼接。

### 11.4 Tools

Tool state 同时具有 nonempty call ID 与 nonempty name 时发送：

```text
response.output_item.added
```

每个 tool call 独立分配 output index。后续 ID 缺失时可用
`tool_call.index` 恢复；同一 index 曾映射多个 call ID 后，该 index 标为 ambiguous，后续无 ID delta
被跳过。

Item kind、name 和 namespace 使用 `StreamContext.toolContext`，规则同第 9.4 节。

Function、namespace 与 tool-search arguments delta 按**最多 10 characters**切片，每片发送：

```text
response.function_call_arguments.delta
```

Stream 结束时，function、namespace 与 tool-search call 依次发送：

```text
response.function_call_arguments.done
response.output_item.done
```

`response.function_call_arguments.done` 必须包含最终 `arguments` 和下游可见的最终 function `name`；
namespace call 使用 namespace 内的 child name，tool-search call 使用映射后的 name。

Custom call 不发送 `response.function_call_arguments.*`。结束时按第 9.4 节解包 input：

```text
response.custom_tool_call_input.delta  // input 非空时
response.custom_tool_call_input.done
response.output_item.done
```

只在最终完整 response 出现的 tool call，必须先补发 `output_item.added`，再发对应 delta/done。

### 11.5 Annotations 与 provider fields

只在第一次看到 `delta.annotations` 时，为可转换 URL citations 排队
`response.output_text.annotation.added`。

Chunk 顶层及 `choice[0].delta.provider_specific_fields` 累积，same key last-value-wins；list 也覆盖，
不追加。终态写入完整 ModelResponse `_hidden_params.provider_specific_fields`。

### 11.6 Completion

Message、reasoning 和每个 tool 维护独立的 added/done state。Finalize：

1. 关闭每个已 added 且未 done 的 item；
2. 最终完整 response 中首次出现的 late tool 先发送 added，再发送 delta/done；
3. tool-only stream 不创建 message item；
4. `response.completed.response.output` 只包含已 added 且已 done 的 items；
5. output 按 `output_index` 升序；
6. 中间公布的 item ID 原样写入 completed snapshot。

每个 emitted event 都必须包含 `sequence_number`。首个 event 为 1；每发送一个 event 加 1；值在
同一 response stream 内严格单调递增且不重复。

上游或 converter 异常把 iterator 标为 finished 后原样传播；不生成 `response.failed`。

## 12. ToolContext 生命周期

1. 每个 request 构造一个 `RequestToolContext`；
2. request conversion、nonstream response 和 stream response 从同一 immutable request 构造
   等价 snapshot；
3. response 不从 original request 重新推导 name ownership；
4. custom、namespace、dynamic namespace、tool-search 与 collision ownership 只读取该 context；
5. context 在 response terminal 或 error 后释放；
6. history store 记录恢复后的 item type、name、namespace、call ID 和 arguments/input。

## 13. Error boundary

Request converter 使用 cc-switch `TransformError` 语义。Response converter 与 async stream 使用
LiteLLM 行为：

- ModelResponse/object 构造失败：异常传播；
- empty choices：返回 completed、empty output response；
- provider completion 异常：原样传播；
- stream converter 内部异常：标记 finished 后原样传播；
- nonstream response 顶层 `error` 字段进入 Responses model；
- 不创建统一 stable error code；
- 不合成 `response.failed`；
- 不注入 `_bridge_diagnostics`。

HTTP status、error body、raw SSE error event 和 credential redaction 由宿主决定，不属于转换核心。

## 14. 测试与完成标准

### 14.1 Request differential

每个 fixture 必须与 cc-switch 固定提交深度等值：

| 类别 | 必测 |
|---|---|
| Top-level | passthrough/drop、boolean stream、stream_options、max token |
| Instructions | string/array、空值、多 system `\n\n`、raw `o1` 与 `O1` |
| Input | object/string/array、role、null/scalar/parts content、empty text/refusal drop |
| Media | image object/string、URL-only file、audio |
| Calls | batching、无 request index、arguments canonicalization |
| Reasoning history | pending、turn boundary、tool-call fallback |
| Tool output media | depth 32、8 KiB threshold、parallel flush |
| Tools | trimmed names、function schema、namespace hash、custom/tool-search精确description、collision |
| Reasoning config | null/defaults、explicit disable、supportsEffort override、unknown effort、五种 mode |
| History | 512 eviction、7-day/default configurable TTL、启动/read/write cleanup、scoped lookup、unique global fallback、ambiguous call ID、Semantic Checkpoint durability |

### 14.2 Response differential

按字段来源分别断言：

- 与 LiteLLM 固定提交等值：nonstream envelope/defaults、empty choices、copied fields、
  all-choice content、first-choice status、message/reasoning/image IDs、annotations、usage、
  provider fields、managed response ID、argument 10-character slicing和异常传播；
- 与 cc-switch 固定提交等值：ToolContext derivation、custom input、namespace/tool-search restoration、
  first-wins ownership、semantic item opening、独立 item state、added-before-done、tool-only无空 message、
  completed output ownership；
- 每个 event 的 `sequence_number` 从 1 开始严格单调递增；
- 不对完整 response/event stream做单一项目的整体深度等值断言。

Golden harness 必须注入 deterministic UUID4 和 clock，并显式固定
`customLlmProvider`、`StreamContext.modelId`。不比较随机值或运行时墙钟的模糊 pattern；
每个 expected object 必须完整列出字段。

### 14.3 Cross-direction fixtures

Custom、hashed/dynamic namespace、tool-search 和 collision fixtures 必须覆盖 request→Chat→response
完整往返。

实现完成必须同时满足：

1. request/input/history 与 cc-switch fixed commit 等值；
2. nonstream response envelope、message、reasoning、image、usage 与 LiteLLM public response等值；
3. tool item restoration 与 cc-switch ToolContext等值；
4. stream response-level fields与 LiteLLM async iterator等值，item lifecycle与 cc-switch等值，
   所有 events使用第 11.6 节 sequence规则；
5. 不存在运行时 behavior profile；
6. 不存在目标仓库 legacy compatibility branch；
7. 不实现 strict adapter、diagnostics、stable error 或 normalized SSE parser。
