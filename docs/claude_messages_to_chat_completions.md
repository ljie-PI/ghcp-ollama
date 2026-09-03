# Anthropic Messages → Chat Completions 桥接规范

> 状态：唯一生产行为规范；不保留目标仓库旧实现兼容分支
>
> 固定来源：请求转换采用 cc-switch
> `3217f72596f2d1c0f879f0a05f83803825d9809f`；非流式响应与流式 event fields采用
> LiteLLM `ae7e50f096a8722bad14d63b6a0d4634d59bf475`；stream terminal closure按第 8.6 节

## 1. 范围与优先级

本文只定义：

1. 已解析 Anthropic Messages request object → Chat Completions request object；
2. 已解析 Chat Completions response object → Anthropic Message object；
3. typed Chat Completions chunk sequence → Anthropic event sequence。

实现只有一个生产 profile：

| 方向 | 规范来源 | 冲突处理 |
|---|---|---|
| request/input | cc-switch | 与 LiteLLM 不同时采用 cc-switch |
| nonstream response | LiteLLM | 采用 LiteLLM |
| streaming response | LiteLLM + 第 8.6 节 | 采用 LiteLLM event fields与本文 terminal closure |

`docs/cc-switch/claude_messages_to_chat_completions.md` 和
`docs/litellm/claude_messages_to_chat_completions.md` 只作为来源说明，不是可选运行时 profile。
固定源码提交与说明文档冲突时，以固定源码提交为准。

目标仓库已有 adapter、HTTP helper、错误类型和测试不参与行为选择。与本文冲突的旧实现必须替换。

本文转换核心不解析 HTTP body 或原始 SSE bytes。宿主负责 JSON/SSE framing、解压、body limit、
认证、重试和路由；转换核心接收本节规定的已解析值。

`POST /v1/messages` 的宿主必须按
[Gateway HTTP contracts](./gateway_http_contracts.md) 要求恰好一个
`anthropic-version: 2023-06-01`；该 header 不进入 Chat request。

进入 converter 前，宿主按 captured Bound Account catalog 解析 model：property 缺失时只使用 valid
preferred model；显式 model 必须是 non-empty string 且精确可见，未知显式 ID 返回 404，且不 fallback
preference。Resolved model 写入 converter input，并在请求期间保持不变。

## 2. 逻辑接口

```text
convertAnthropicRequest(
  request: JsonObject,
  provider: ProviderContext
) -> ChatRequest | TransformError

convertChatResponse(
  response: ChatResponse
) -> AnthropicMessage | TransformError

AnthropicStreamConverter.start(
  model: string
) -> AnthropicEvent

AnthropicStreamConverter.consume(
  chunk: ChatChunk
) -> AnthropicEvent[]

AnthropicStreamConverter.finish()
  -> AnthropicEvent[]
```

```text
ProviderContext {
  anthropicBaseUrl?: string
  baseUrl?: string
  baseURL?: string
  apiEndpoint?: string
  promptCacheKey?: string
}
```

`ProviderContext` 只承载 cc-switch request 转换实际读取的 provider 信息。不得加入由目标仓库旧实现
推导的 capability、lineage、response ID 或 diagnostic。

request 转换不截断 tool name，因此 response 转换使用空的 tool-name reverse map；tool name 原样进入
LiteLLM response 算法。

## 3. Request 顶层转换

### 3.1 字段表

转换器只构造下表中的 Chat 字段。未知或未列出的 Anthropic 顶层字段被丢弃。

| Anthropic request | Chat request | 规则 |
|---|---|---|
| `model` | `model` | 仅 string 时复制 |
| `system` | system message | 见第 4.1 节 |
| `messages` | `messages` | 见第 4 节 |
| `max_tokens` | `max_tokens` / `max_completion_tokens` | o-series 使用后者 |
| `temperature` | `temperature` | 字段存在时原值复制 |
| `top_p` | `top_p` | 字段存在时原值复制 |
| `stop_sequences` | `stop` | 字段存在时原值复制 |
| `stream` | `stream` | 字段存在时原值复制 |
| `thinking` / `output_config.effort` | `reasoning_effort` | 见第 6 节 |
| `tools` | `tools` | 见第 5 节 |
| `tool_choice` | `tool_choice` | 见第 5.3 节 |

以下字段不进入 Chat request：

```text
top_k
metadata
service_tier
container
mcp_servers
cache_control
output_format
output_config.format
context_management
```

转换器不提供 strict unknown-field error；已知字段的值除本文明确转换外不做额外类型或范围校验。

### 3.2 max token 字段

直接检查 raw model string；满足以下条件时使用 `max_completion_tokens`：

```text
model[0] == lowercase ASCII "o"
and model[1] is ASCII digit
```

其他 model 使用 `max_tokens`。model 缺失、非 string 或长度不足时也使用 `max_tokens`。

### 3.3 stream usage

转换结果的 `stream === true` 时：

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

若 provider 预处理已经在转换结果中放入 object `stream_options`，保留其他键并覆盖
`include_usage:true`；其他类型替换为上述 object。非流式不添加 `stream_options`。

`ProviderContext` 自有 property `promptCacheKey` 时写入该 string，包括 empty string；property 缺失时
不写入。存在但非 string 属于调用方 context 错误。不得从 Anthropic metadata、session ID 或
`cache_control` 推导该值。

## 4. system、messages 与历史

### 4.1 system

`system`：

- string：去除 billing attribution 后，非空时生成一条 system message；
- array：每个具有 string `.text` 的 block 独立生成 system message；
- 其他：忽略。

Billing attribution 只在文本以以下字面量开头时处理：

```text
x-anthropic-billing-header:
```

处理顺序：

1. 删除第一行；
2. 删除其后最多一个 CRLF、LF 或 CR 空行；
3. 保留其余文本；
4. header 不在开头时不处理。

扫描完全部 Anthropic messages 后：

- 没有 system message：不处理；
- 恰好一条：把该 message 原 shape 移到 `messages[0]`，不做 parts 提取或 string 合并；
- 多条：提取每条 system string content；parts array 提取其中 string `.text`；丢弃空结果；
  使用单个 `\n` 连接为唯一首条 system message；
- 非 system message 相对顺序保持不变。

### 4.2 普通 message

每个 `messages[]`：

- `role` 为 string 时原样使用，否则默认 `"user"`；
- content 缺失时生成 `{"role":role,"content":null}`；
- content 为 string 时原样使用；
- content 为 array 时按本节转换 blocks；
- 其他 JSON 值原样写入 `content`。

Text block：

```json
{"type":"text","text":"..."}
```

只复制 `type` 和 `text`，不复制 `cache_control`。

Image block 转为：

```json
{
  "type": "image_url",
  "image_url": {"url": "<resolved URL>"}
}
```

支持：

- `source.type=="base64"`：`data:<media_type>;base64,<data>`；
- `source.type=="url"`：使用 `source.url`；
- cc-switch media helper 已识别的 MCP/image URL shape。

无法识别的 image 和所有普通 `document` block 被忽略。

最终普通 message：

- 没有 text/image 且没有 tool call：不生成；
- 仅一个 text part：简化为 string；
- 一个 image 或多个 parts：保持 parts array；
- 只有 tool calls：`content:null`；
- text/image 与 tool calls 可以共存。

### 4.3 `tool_use`

每个 `tool_use` 合并到当前 assistant Chat message 的 `tool_calls[]`：

```json
{
  "id": "<id or empty string>",
  "type": "function",
  "function": {
    "name": "<name or empty string>",
    "arguments": "<canonical JSON>"
  }
}
```

`input` 缺失时使用 `{}`。同一 message 的多个 `tool_use` 保持输入顺序。

Canonical JSON：

1. object key 在每一层按 Unicode code point 升序；
2. array 保持顺序；
3. 使用 compact JSON，不写无意义空白；
4. string escaping、number 和 null/bool 输出匹配 `serde_json::Value` serializer。

### 4.4 `tool_result`

每个 `tool_result` 立即生成独立 Chat tool message：

```json
{
  "role": "tool",
  "tool_call_id": "<tool_use_id or empty string>",
  "content": "<string>"
}
```

- content 为 string：原样保留；
- content 缺失：空 string；
- 其他 JSON：使用第 4.3 节 canonical JSON；
- `is_error` 被忽略。

一个 Anthropic message 同时含 tool results 和普通内容时，Chat message 顺序为：

1. 全部 tool messages；
2. 可选 synthetic media user message；
3. 剩余 text/image/tool_use 形成的普通 message。

Tool-result media 必须加载并严格应用
`docs/cc-switch/codex_response_to_chat_completions.md` 的 tool-result media extraction 规则：

```text
[cc-switch: tool result media moved to the following user message]
[cc-switch: media output of tool call <tool_use_id>]
```

多个并行 tool result 的媒体合入同一 synthetic user message，且不得插入连续 tool messages 中间。

### 4.5 thinking history

以下任一字符串转小写后包含 `deepseek`、`mimo` 或 `xiaomimimo` 时启用历史保留：

- request model；
- `provider.anthropicBaseUrl`；
- `provider.baseUrl`；
- `provider.baseURL`；
- `provider.apiEndpoint`。

仅当 assistant message 含 tool calls 时：

- 收集 thinking block 的非空 `.thinking`，用 `\n` 连接；
- `redacted_thinking` 记为 `[redacted thinking]`；
- 没有可用 thinking 时使用 `tool call`；
- 写入 Chat assistant message 顶层 `reasoning_content`。

其他情况下 thinking/redacted-thinking 被丢弃。Thinking-only message 不生成 Chat message。

## 5. Tools 与 schema

### 5.1 Tool declarations

- 过滤 `type=="BatchTool"`；
- 其他项全部转换为 Chat function tool；
- name 缺失时为空 string；
- description 缺失时为 JSON null；
- input_schema 缺失时使用 `{}`；
- `strict` 和 `cache_control` 不复制；
- 过滤后为空时不输出 `tools`。

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  }
}
```

### 5.2 Schema cleanup

1. root 是 object 且缺 `type` 时添加 `"type":"object"`；
2. 此时若也缺 `properties`，添加 `"properties":{}`；
3. root 已含 `type` 时不改写；
4. 非 object schema 不包裹；
5. 当前 node 的 `format=="uri"` 时删除 `format`；
6. 递归遍历 `properties` values 和 `items`；
7. 不遍历 `oneOf`、`anyOf`、`allOf`、`$defs` 或 `definitions`。

Tool name 不截断，不建立 reverse map，不识别 LiteLLM hosted/native tool。Web-search tool 按普通
function tool 处理。

### 5.3 Tool choice

| Anthropic input | Chat output |
|---|---|
| `"auto"` / `{"type":"auto"}` | `"auto"` |
| `"any"` / `{"type":"any"}` | `"required"` |
| `"none"` / `{"type":"none"}` | `"none"` |
| `{"type":"tool","name":"f"}` | `{"type":"function","function":{"name":"f"}}` |
| 其他 | 原样保留 |

过滤 tools 后不自动删除 `tool_choice`。`disable_parallel_tool_use` 不映射。

## 6. Reasoning request

只有 model 属于下列 family 时才添加 `reasoning_effort`：

- o-series：小写 model 以 `o` 开头，第二个字符是 ASCII digit；
- 小写 model 以 `gpt-` 开头，下一字符是 digit 且 `>= "5"`；
- `grok-4.5`、`grok-4.5-*` 或 `grok-build-*`。

优先读取 string `output_config.effort`：

| input | output |
|---|---|
| `low` / `medium` / `high` | 原值 |
| `max` | `xhigh` |
| 其他 | 不输出 |

只有该字段是 string 时才抑制 `thinking` fallback；未知 string 不输出且不 fallback。字段为
non-string 时忽略并继续读取 `thinking`。

否则读取 `thinking`：

| input | `reasoning_effort` |
|---|---|
| `type:"adaptive"` | `xhigh` |
| enabled 且 `budget_tokens < 4000` | `low` |
| enabled 且 `4000 <= budget_tokens < 16000` | `medium` |
| enabled 且 `budget_tokens >= 16000` | `high` |
| enabled 且缺 budget | `high` |
| disabled、未知或缺失 | 不输出 |

`budget_tokens` 只有能表示为 unsigned integer 时参与区间判断；negative、float、bool、string 和超出
unsigned range 的值按缺失处理，因此 enabled thinking 映射为 `high`。

原 `thinking`、`output_config` 和 structured-output fields 均不透传。

## 7. 非流式 Chat response

### 7.1 Envelope 与 choices

输出：

```json
{
  "id": "<chat response id>",
  "type": "message",
  "role": "assistant",
  "model": "<chat response model or unknown-model>",
  "content": [],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0
  }
}
```

- `id` 原样使用，不添加 `msg_`；
- `choices` 必须至少有一项；空数组在读取首项 stop reason 时抛出转换错误，不返回部分对象；
- content 遍历并追加**所有** choices；
- 总 `stop_reason` 只读取 `choices[0].finish_reason`；
- 不执行 context-management/compaction polyfill。

每个 choice 按以下顺序追加 blocks：

1. truthy `thinking_blocks`；
2. 当 `thinking_blocks` 缺失、null 或 empty list 时的 `reasoning_content` fallback；
3. text；
4. tool calls。

Truthy `thinking_blocks`：

- `thinking` → `{"type":"thinking","thinking":"...","signature":"..."}`；
- `redacted_thinking` → `{"type":"redacted_thinking","data":"..."}`；
- regular thinking 的 `.thinking` 不是 non-whitespace string 时删除；
- redacted block 即使 data empty 也保留；
- nonempty list 即使最终只含被删除的 regular blocks，也抑制 `reasoning_content` fallback。

没有 `thinking_blocks` 且 `reasoning_content` 非空时：

```json
{"type":"thinking","thinking":"...","signature":null}
```

`message.content !== null` 时生成一个 text block；空 string 也生成。输入必须已是 typed Chat response
要求的 string，不在此展平 assistant multimodal parts。

### 7.2 Tool calls

每个 typed Chat tool call：

```json
{
  "type": "tool_use",
  "id": "<normalized id>",
  "name": "<original name>",
  "input": {}
}
```

ID 规则：

1. 在第一个 `__thought__` separator 处截断；
2. 把不属于 `[a-zA-Z0-9_-]` 的每个字符替换为 `_`；
3. 结果为空时使用 `tool_use_id`。

Arguments parser：

1. null、空或全 whitespace → `{}`；
2. 先执行标准 JSON parse，允许任意 JSON value；
3. 失败后扫描 string，忽略 quoted string 内字符，记录未闭合 `{`/`[`；
4. 删除尾部逗号，按逆序补齐 `}`/`]`，再次 parse；
5. 无未闭合 opener 或修复后仍失败时抛出 `ValueError`。

先选择 provider-specific container：tool-call 外层 object truthy 时使用它，否则使用 function-level
object。选中的 container 内 `thought_signature` 为 truthy 时，tool-use block 加入：

```json
{"provider_specific_fields":{"signature":"<signature>"}}
```

### 7.3 Stop reason

| Chat finish_reason | Anthropic stop_reason |
|---|---|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| 其他或 null | `end_turn` |

`stop_sequence` 固定为 null。

### 7.4 Usage

Cache read 优先级：

1. `cache_read_input_tokens`；
2. `_cache_read_input_tokens`；
3. `prompt_tokens_details.cached_tokens`。

Cache creation 优先级：

1. `cache_creation_input_tokens`；
2. `_cache_creation_input_tokens`；
3. `prompt_tokens_details.cache_creation_tokens`；
4. `prompt_tokens_details.cache_write_tokens`。

只接受正 integer，或数值为正整数的 float；bool、负数、零和小数按 0。

```text
input_tokens =
  max(0, prompt_tokens - cache_read - cache_creation)
output_tokens = completion_tokens
```

Cache 值大于 0 时才输出相应 Anthropic 字段。Web-search request count 优先采用 LiteLLM helper
已计算值，否则读取正整数 `prompt_tokens_details.web_search_requests`。

`prompt_tokens` 与 `completion_tokens` 来自 typed Chat usage，缺失时按 0。Cache/web-search helper
只接受正 integer，或数值为正整数的 float；bool、负数、0 和有小数部分的 float 按 0。

## 8. Streaming Chat response

### 8.1 输入边界与 framing

转换器接收宿主已经解析为 typed `ChatChunk` 的序列，不接收 `data:` 行或 `[DONE]`。宿主的正常
iterator exhaustion 调用 `finish()`。

每个 `AnthropicEvent` 的 SSE 表示使用 Python 3 default `json.dumps`：

```text
event: <event.type>
data: <default-json-dumps event>

```

因此 separators 默认包含 `", "` 和 `": "`，`ensure_ascii=true`，不是 compact JSON。

### 8.2 `message_start`

`start(model)` 恰好生成一次：

```json
{
  "type": "message_start",
  "message": {
    "id": "msg_<uuid4>",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "<provider-local model>",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
```

UUID4 使用小写 hex 和标准 hyphen。不得复用 Chat stream ID。

### 8.3 Chunk normalization

任意 nonempty choices chunk 的 `choices[0]` 同时含 content payload 和 finish reason 时先拆为：

1. content-only chunk：删除 finish reason 和 usage；
2. finish-only chunk：清空 content/tool/reasoning/thinking，保留 finish reason 和 usage。

单 choice chunk 同时含多种 payload 时按顺序拆为：

```text
reasoning or thinking
text
tool calls
```

只有 payload-kind 拆分要求 choices 数量恰好为 1。该拆分过程中，signature-less
`thinking_blocks` 才会规范化为 `reasoning_content`；single-payload chunk 不做该规范化。以下情况
不按 payload kind 拆分：

- choices 数量不是 1；
- tool call 只有 arguments continuation、没有 function name；
- 只有一种 payload kind。

### 8.4 Content blocks

第一个非空 payload 打开 block：

| Chat delta | Anthropic block |
|---|---|
| `content` | `text` |
| 新 tool call name/ID | `tool_use` |
| `thinking_blocks` | thinking |
| `reasoning_content` | `thinking` |

Role-only、空 content、空 reasoning 和空 thinking 不打开 block。

Payload type 改变时必须依次输出：

1. previous `content_block_stop`；
2. new `content_block_start`；
3. 当前 chunk 的非空 `content_block_delta`。

Block index 从 0 开始，每次 start 后递增。

Delta 映射：

| Chat delta | Anthropic delta |
|---|---|
| content | `text_delta` |
| tool arguments | `input_json_delta` |
| thinking text | `thinking_delta` |
| thinking signature | `signature_delta` |

Streaming 不生成 `redacted_thinking` block。Signed thinking 的 block start 保留该 chunk 中完整
thinking 和 signature，随后该 chunk 只输出 `signature_delta`；同一 chunk 的 thinking text 不再作为
`thinking_delta` 输出。多个 choices 的 text/reasoning 按 choice 顺序拼接。Tool arguments 不跨
choices 拼接：遇到每个 tool-bearing choice 时重置 `partial_json`；最终使用最后一个 tool-bearing
choice，并只把该 choice 内的 calls 按数组顺序拼接。

新的 function name 表示新的 tool block：先关闭前一个，再打开下一个。只有 arguments continuation
时继续当前 tool block。

新 tool call 的 ID 缺失时生成 UUID4，再按第 7.2 节 ID 规则归一化。原 ID 含
`__thought__<signature>` 时，separator 前部分作为 ID，后部分作为 tool block 的
`provider_specific_fields.signature`。

### 8.5 Event schemas

除第 8.2 节 `message_start` 外，事件 object 固定为：

```text
content_block_start {
  type: "content_block_start"
  index: integer
  content_block:
    | {type:"text", text:""}
    | {
        type:"tool_use",
        id:string,
        name:string,
        input:{},
        provider_specific_fields?:{signature:string}
      }
    | {type:"thinking", thinking:string, signature:string}
}

content_block_delta {
  type: "content_block_delta"
  index: integer
  delta:
    | {type:"text_delta", text:string}
    | {type:"input_json_delta", partial_json:string}
    | {type:"thinking_delta", thinking:string}
    | {type:"signature_delta", signature:string}
}

content_block_stop {
  type: "content_block_stop"
  index: integer
}

message_delta {
  type: "message_delta"
  delta: {stop_reason:"end_turn"|"max_tokens"|"tool_use"}
  usage: AnthropicUsage
}

message_stop {
  type: "message_stop"
}
```

Unknown extra event fields不得由目标实现自行加入。

### 8.6 Finish 与 usage

Finish chunk 生成待发送：

```json
{
  "type": "message_delta",
  "delta": {"stop_reason":"end_turn|max_tokens|tool_use"},
  "usage": {"input_tokens":0,"output_tokens":0}
}
```

转换器暂存该事件：

- 后续 usage-only chunk 到达时，按第 7.4 节合并 usage，再发送；
- iterator 正常结束但没有 usage-only chunk 时，以 finish chunk 已有 usage或
  `{"input_tokens":0,"output_tokens":0}` 发送；
- 发送顺序固定为：

```text
content_block_stop
message_delta
message_stop
```

`message_stop` 恰好一次。Final message delta 发出后忽略后续 provider chunks。

没有任何 finish reason 而自然 exhaustion 时，先对 active content block发送一次
`content_block_stop`，再发送 `message_stop`；不合成 `message_delta`。没有 active block 时只发送
`message_stop`。首个 chunk 只有 finish reason、没有 payload 时，先打开并关闭 empty text block，再
发送 `message_delta` 与 `message_stop`。

目标实现采用 LiteLLM async iterator 语义：provider/转换异常传播给宿主，不合成 cc-switch
`event:error`，也不在异常后补成功 `message_stop`。

## 9. 测试与完成标准

必须使用固定输入和完整期望输出测试：

| 类别 | 必测 |
|---|---|
| Request fields | unknown drop、raw `o1`/`O1` max token、stop、stream usage、present empty prompt cache key |
| System | billing header、CR/LF/CRLF、空 system、单条原 shape、多条合并、单 `\n` |
| Messages | missing/string/array content、text/image/document、空 parts |
| Tool history | 并行 tool_use、tool_result string/JSON/media、thinking whitelist |
| Tools | BatchTool、schema defaults、URI cleanup、组合关键字不递归、unknown tool choice |
| Reasoning | model families、string/non-string effort precedence、unknown string、budget boundaries |
| Nonstream | 多 choices、truthy/empty thinking blocks、redacted empty data、ID normalization、argument repair/failure |
| Usage | 每个 alias、bool/float/integer约束、cache subtraction、web-search count |
| Stream | first-choice finish split、多-choice payload、block switching、signed thinking、无 redacted stream |
| Terminal | finish-first empty block、usage-only、missing usage zero fields、no-finish active/empty exhaustion、exception propagation |

完成必须同时满足：

1. request object 与 cc-switch 固定提交的转换结果深度等值；
2. nonstream response 与 LiteLLM 固定提交的转换结果深度等值；
3. stream 的 Anthropic event type、payload和顺序与 LiteLLM async wrapper 等值；
4. 目标仓库旧 adapter 行为不影响任何断言；
5. request 不出现 LiteLLM-only hosted tools、name truncation、structured output 或 context management；
6. response 不出现 cc-switch-only legacy fallback、SSE parser 或重复 `[DONE]` 行为。

Golden harness 必须注入 deterministic UUID4；SSE expected text必须使用 Python default
`json.dumps` spacing/escaping，而不是只做 JSON parse 后深度等值。
