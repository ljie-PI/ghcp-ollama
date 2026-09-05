# Ollama Chat → Chat Completions 桥接规范

> 状态：唯一生产行为规范；不保留目标仓库旧实现兼容分支
>
> 固定来源：Ollama `f96e7aa0513b9973a0ccc71be414c2ecb9d65b1a`；
> LiteLLM `ae7e50f096a8722bad14d63b6a0d4634d59bf475`

## 1. 范围与优先级

本文定义：

1. Ollama `POST /api/chat` request → OpenAI-compatible Chat Completions request；
2. Chat Completions JSON response → Ollama Chat JSON；
3. Chat Completions SSE bytes → Ollama Chat NDJSON。

固定优先级：

| 方向 | 规范来源 |
|---|---|
| 入站 Ollama request、Ollama response shape、NDJSON bytes | 固定 Ollama 源码 |
| Chat response 兼容、finish/reasoning/tool/usage fallback | 固定 LiteLLM 源码 |

实现只使用上述固定来源，不提供运行时 profile 或 capability/pointer 配置。目标仓库已有 adapter、
默认值、header、error 和 stream 行为不参与规范选择；冲突的旧实现必须替换。

目标 Chat dialect 固定采用 Ollama 同一提交中 OpenAI compatibility DTO 可表达的字段。GitHub hosted
Copilot 是否接受全部字段是外部部署约束，不得通过模型名、hostname 或目标仓库旧代码猜测。

## 2. Transport

### 2.1 Downstream Ollama

- Route：`POST /api/chat`；
- `stream` 缺失时默认为 `true`；
- nonstream success：`Content-Type: application/json; charset=utf-8`；
- stream success：`Content-Type: application/x-ndjson`；
- 每个 stream object 后精确一个 LF；
- NDJSON 中不出现 `data:`、`event:` 或 `[DONE]`。

### 2.2 Upstream Chat

- Request：JSON Chat Completions object；
- Nonstream response：JSON Chat Completion；
- Stream response：OpenAI-compatible SSE；
- `stream:true` 时 request 固定加入
  `stream_options:{"include_usage":true}`。

本文不规定 token/endpoint 获取、认证 header、重试或 timeout。
共同 request parsing、resource limits、admission 和 timeout 由
[Gateway HTTP contracts](./gateway_http_contracts.md) 定义；Ollama error body 与 stream
post-commit 行为仍以第 9 节为准。

## 3. 固定 DTO

### 3.1 Ollama request

```text
OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  stream?: boolean = true
  format?: JsonValue
  keep_alive?: string | number
  tools?: OllamaTool[]
  options?: Map<string, JsonValue> | null
  think?: boolean | "low" | "medium" | "high" | "max"
  truncate?: boolean
  shift?: boolean
  _debug_render_only?: boolean
  logprobs?: boolean
  top_logprobs?: integer
}

OllamaMessage {
  role: string
  content: string
  thinking?: string
  images?: base64[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
  tool_call_id?: string
}

OllamaToolCall {
  id?: string
  function: {
    index: integer
    name: string
    arguments: ordered JSON object
  }
}
```

Message JSON decode 后把 role 转为 lowercase。

```text
OllamaTool {
  type: string
  items?: JsonValue
  function: {
    name: string
    description?: string
    parameters: OllamaToolFunctionParameters
  }
}

OllamaToolFunctionParameters {
  type: string
  $defs?: JsonValue
  items?: JsonValue
  required?: string[]
  properties: ordered Map<string, OllamaToolProperty>
}

OllamaToolProperty {
  anyOf?: OllamaToolProperty[]
  type?: string | string[]
  items?: JsonValue
  description?: string
  enum?: JsonValue[]
  properties?: ordered Map<string, OllamaToolProperty>
  required?: string[]
}
```

Tool 没有 `strict` 字段。Property 和 tool-call arguments 的 member insertion order 必须保留。

### 3.2 Ollama response

```text
OllamaChatResponse {
  model: string
  remote_model?: string
  remote_host?: string
  created_at: RFC3339Nano
  message: OllamaMessage
  done: boolean
  done_reason?: string
  _debug_info?: {
    rendered_template: string
    image_count?: integer
  }
  logprobs?: OllamaLogprob[]
  total_duration?: integer
  load_duration?: integer
  prompt_eval_count?: integer
  prompt_eval_duration?: integer
  eval_count?: integer
  eval_duration?: integer
}
```

Duration 单位为 nanoseconds。所有 metrics 使用 Go `omitempty` 语义；0 不输出。普通 remote Chat bridge
不生成 duration、debug 或 remote 字段。

<a id="request-conversion"></a>

## 4. Request 转换

### 4.1 顶层字段

| Ollama | Chat | 规则 |
|---|---|---|
| `model` | `model` | 必须是非空 string，不提供默认值 |
| `messages` | `messages` | 非空 array；第 4.2 节 |
| `tools` | `tools` | 第 4.3 节 |
| `format` | `response_format` | 第 4.5 节 |
| `options` | Chat sampling/token fields | 第 4.4 节 |
| `stream` | `stream` | 缺失为 true |
| `think` | `reasoning_effort` | string/false 按第 4.5 节；true 返回 `unsupported_semantics` |
| `_debug_render_only` | 同名 | 原 boolean |
| `logprobs` | 同名 | 原 boolean |
| `top_logprobs` | 同名 | integer 0..20 |
| `keep_alive` | 无 | source-valid but unrepresentable |
| `truncate` | 无 | source-valid but unrepresentable |
| `shift` | 无 | source-valid but unrepresentable |

Unknown top-level members 按 Go struct JSON decode 行为忽略。Missing/null `options` 等价于 empty map。

`top_logprobs` 即使 `logprobs:false` 也可被解析并发送；此时按 Ollama 语义没有效果，不额外拒绝。

Empty messages、`keep_alive`、`truncate`、`shift` 和第 4.4 节不可表达 options 均归类为
`unsupported_semantics`，必须在零 upstream call 时返回，并按第 9 节输出错误。

### 4.2 Messages

Role 只执行 lowercase 后原样复制。固定 `Message.UnmarshalJSON` 不做四值 allowlist 校验。

Message mapping：

| Ollama | Chat |
|---|---|
| `role` | `role` |
| `content` | string content，含 images 时变为 text part |
| `thinking` | `reasoning` |
| `tool_name` | `name` |
| `tool_call_id` | `tool_call_id` |

Images 是裸 base64。逐项：

1. 严格 base64 decode；
2. 通过 decoded magic 只接受 JPEG/JPG、PNG 或 WebP；
3. 生成 `data:<mime>;base64,<original-data>` image URL part；
4. undecodable 或未知 magic 失败，不猜 JPEG；
5. message content 作为首个 text part，空 string 仍保留。

Assistant tool calls：

- function arguments 必须是 JSON object；
- compact serialize 为 Chat string，保留 object member insertion order；
- function name 原样；
- function index 写到 Chat tool call 顶层 `index`；
- nonempty ID 原样写入；缺失时省略，不生成 synthetic ID；
- type 固定 `"function"`。

Tool-result message 的 `tool_call_id` 和 `name` 分别直接来自 Ollama `tool_call_id` 与 `tool_name`。
不建立本地 call/result consumption state。

### 4.3 Tool declarations

Ollama `tools[]` 按第 3.1 节固定类型解析后直接映射为 Chat tools：

- `type` 原值；
- `items` 原值；
- function name/description/parameters 原值；
- parameters 和 properties 保留 insertion order；
- 不注入空 schema；
- 不增加 `strict`；
- 不增加 64-character regex 或 capability gate。

非法类型按 Ollama fixed DTO decode 失败。

### 4.4 Options

只映射 Chat 可表达的字段：

| `options` | Chat |
|---|---|
| `num_predict` | `max_tokens` |
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `seed` | `seed` |
| `stop` | `stop` |
| `frequency_penalty` | `frequency_penalty` |
| `presence_penalty` | `presence_penalty` |

规则：

- `num_predict` 必须是正 integer；`-1`、`-2` 和其他非正值是 Ollama 可识别但 Chat 无法等价表达；
- `stop` 必须是 string array，不接受 scalar，不增加四项上限；
- numeric fields 不做 string/bool coercion；
- 缺失 fields 不发送 target defaults。

下列 Ollama options 不透传到 Chat：

```text
num_keep
top_k
min_p
typical_p
repeat_last_n
repeat_penalty
num_ctx
num_batch
num_gpu
main_gpu
use_mmap
num_thread
draft_num_predict
```

显式提供这些 source-valid fields 时不得悄悄忽略或按同名字段发送；它们属于不可表达语义。

### 4.5 Format 与 thinking

`format:"json"`：

```json
{"response_format":{"type":"json_object"}}
```

`format:<schema object>`：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "schema": {
        "type": "object",
        "properties": {}
      }
    }
  }
}
```

不增加 `name` 或 `strict`。

其他合法 JSON `format` 值能被 Ollama `json.RawMessage` 接收，但不能映射到固定 Chat response-format
shape，归类为 `unsupported_semantics`。

`think`：

| Ollama | Chat `reasoning_effort` |
|---|---|
| `false` | `"none"` |
| string | 原 string |

`true` 返回 `unsupported_semantics`，不调用上游。不使用 RFC 6901 pointer，不按模型名推测。

### 4.6 Request 示例

Ollama：

```json
{
  "model": "gpt-5",
  "messages": [
    {
      "role": "assistant",
      "content": "",
      "thinking": "checking",
      "tool_calls": [{
        "id": "call_1",
        "function": {
          "index": 0,
          "name": "weather",
          "arguments": {"city":"Tokyo"}
        }
      }]
    },
    {
      "role": "tool",
      "content": "sunny",
      "tool_name": "weather",
      "tool_call_id": "call_1"
    }
  ],
  "stream": true,
  "think": "medium",
  "options": {
    "num_predict": 256,
    "stop": ["END"]
  }
}
```

Chat：

```json
{
  "model": "gpt-5",
  "messages": [
    {
      "role": "assistant",
      "content": "",
      "reasoning": "checking",
      "tool_calls": [{
        "id": "call_1",
        "index": 0,
        "type": "function",
        "function": {
          "name": "weather",
          "arguments": "{\"city\":\"Tokyo\"}"
        }
      }]
    },
    {
      "role": "tool",
      "content": "sunny",
      "name": "weather",
      "tool_call_id": "call_1"
    }
  ],
  "stream": true,
  "stream_options": {"include_usage":true},
  "reasoning_effort": "medium",
  "max_tokens": 256,
  "stop": ["END"]
}
```

<a id="nonstream-chat-response"></a>

## 5. Nonstream Chat response

### 5.1 Choice

`choices` 必须是 array，并且恰好一个 choice 的 `index==0`：

- 无 index 0：invalid upstream response；
- 多个 index 0：invalid upstream response；
- 其他 index 被忽略；
- 选中 choice 的 `message` 必须是 object。

不得按 array position 把非 0 choice 当主 choice。

### 5.2 Output

```text
model       = original Ollama request.model
message.role = "assistant"
message.content = selected message.content ?? ""
done        = true
```

Thinking 提取优先级：

1. 只要 key `message.reasoning_content` 存在，就使用其值并停止 fallback；
2. 否则只要 key `message.reasoning` 存在，就使用其值并停止 fallback；
3. 否则从 content 开头的完整
   `<think>...</think>`、`<thinking>...</thinking>` 或
   `<budget:thinking>...</budget:thinking>` 提取。

Tag 必须从 content 第一个字符开始并同时存在 closing tag。Opening 与 closing 各自可为 `think`、
`thinking` 或 `budget:thinking`，固定 regex 不要求二者名称相同。未闭合或位于文本中间时不提取。
匹配后 opening/closing 之间为 thinking，closing 后全部文本为 visible content。

显式 reasoning key 的值必须是 string 或 null；null 表示无 thinking，其他类型是 invalid upstream
response。Content 必须是 string 或 null；null 规范化为 empty string。

Tool calls：

- Chat function arguments 必须是可 parse 的 JSON object；
- 输出 ordered object，不接受 array/scalar；
- ID 原样保留，缺失时省略；
- function index 优先使用 Chat 顶层非负 `index`，缺失时使用 call array position；
- function name 原样。

Finish reason：

| Chat | Ollama `done_reason` |
|---|---|
| `length` | `"length"` |
| `tool_calls` / `function_call` 且存在 nonempty converted tool calls | `"stop"` |
| `stop` | `"stop"` |
| null / missing | `"stop"` |
| `content_filter` | `"stop"` |
| 未知值 | `upstream_invalid_response` |
| `tool_calls` / `function_call` 且没有 converted tool calls | `upstream_invalid_response` |

### 5.3 Usage 与 logprobs

存在 nonnegative integer usage 时：

```text
prompt_eval_count = usage.prompt_tokens
eval_count        = usage.completion_tokens
```

Nonstream 缺 `prompt_tokens` 时调用
`litellm.token_counter(model="", messages=<converted Chat messages>)`；
缺 `completion_tokens` 时调用
`litellm.token_counter(model="", text=<converted message content>)`。不得从 `total_tokens` 倒推，也
不得用 string length 替代该 helper。

Streaming 缺 count 时不调用 tokenizer，terminal 对应 count 固定为 0。

Logprob item：

```text
OllamaTokenLogprob {
  token: string
  logprob: finite number
  bytes?: integer[] where each 0..255
}

OllamaLogprob {
  token: string
  logprob: finite number
  bytes?: integer[] where each 0..255
  top_logprobs?: OllamaTokenLogprob[]
}
```

Nested `top_logprobs[]` item 不能再含 `top_logprobs`。任一 item malformed 时整个 logprobs 转换失败，
不返回部分 array。

### 5.4 Timestamp 与省略字段

Chat `created` 为 finite Unix integer seconds 时转 UTC `time.Time`，再以 Go RFC3339Nano 输出；整秒示例
是 `2023-11-14T22:13:20Z`，不是 `.000Z`。

Chat `created` 为 null 或缺失时，在开始 nonstream response 转换时读取一次 injected clock。其他
非法类型返回 invalid upstream response。

不输出：

```text
id
remote_model
remote_host
_debug_info
total_duration
load_duration
prompt_eval_duration
eval_duration
```

## 6. SSE parser

### 6.1 Frame union

```text
SseFrame =
  | ChatChunk(JsonObject)
  | ErrorFrame(JsonObject | string)
  | Done
```

Parser 只解析 framing，不生成 Ollama response。Reducer 是 `Done` 的唯一消费者和 terminal 唯一 owner；
不存在第二个 `finish("done_marker")`。

### 6.2 Wire grammar

1. 非 2xx upstream response 不进入 parser；
2. 使用单个 incremental UTF-8 decoder；
3. 只忽略 stream 开头一个 BOM；
4. 接受 LF、CRLF 和 CR；
5. 空行结束 event；
6. comment line 忽略；
7. field 在第一个 `:` 分割，只移除 value 开头一个 space；
8. 多个 data lines 用 `\n` 连接；
9. 无 data 的 event 忽略；
10. data 精确等于 `[DONE]` 时发 `Done`；
11. `event:error` 或 JSON object 根含 `error` 时发 `ErrorFrame`；
12. 其他 data 必须 parse 为单个 JSON object，发 `ChatChunk`。

Parser 进入 done/error 后忽略全部后续 bytes；首个 `[DONE]` 是 absorbing terminal，包括后续普通 data、
重复 `[DONE]` 和 comments。

EOF 有残余 UTF-8/code point、line、event 或 JSON 时返回 `upstream_stream_truncated`。无残余但未见
`[DONE]` 时同样返回 `upstream_stream_truncated`，即使此前已收到 finish reason。

## 7. Stream reducer

### 7.1 State

```text
StreamState {
  phase: "open" | "finished" | "errored"
  requestModel: string
  createdAt: time.Time
  finishReason?: string
  usage: {
    promptTokens?: integer
    completionTokens?: integer
  }
  contentFragments: string[]
  reasoningFragments: string[]
  toolCalls: Map<integer, {
    id?: string
    name?: string
    argumentFragments: string[]
  }>
}
```

只消费唯一 `choice.index==0`。Usage-only `choices:[]` 合法；非空 choices 没有 index 0、多个 index 0，
或 choice/message/delta 类型错误时终止为 upstream error。

Output `model` 始终是 original request model，不采用 upstream Chat model。

构造 stream reducer 时读取一次 injected clock并写入 `createdAt`。所有 chunk 的 `created` 字段忽略。

### 7.2 Content、reasoning 与 logprobs

每个 chunk：

- string `delta.content` 追加 content；
- key `delta.reasoning_content` 存在时只读取该字段，否则读取 `delta.reasoning`；
- 两个 reasoning key 都不存在时才启用 LiteLLM stream tag state。对每个 nonempty content
  fragment 按顺序执行：
  1. 若此前 `started=true && finished=false`，先置 `finished=true`；
  2. fragment 含 `<think>` 时删除全部该 substring，并置 `started=true`；
  3. fragment 含 `</think>` 且 `started=true` 时删除全部该 substring，并置 `finished=true`；
  4. 最终 `started=true && finished=false` 时作为 thinking，否则作为 content。
  不识别 `<thinking>`/`<budget:thinking>`，不拼接跨 fragment tag；
- logprobs 逐 chunk按第 5.3 节转换，不跨 chunk累积。

非 terminal chunk 有 content/reasoning/logprobs 时输出一个 `done:false` object。同一 chunk 的 content
和 thinking 保留在同一 Ollama message。成功写出后推进各自 cursor；terminal 只包含尚未输出的
content/thinking，不重复已输出 fragment。

### 7.3 Tool calls

`delta.tool_calls[]` 必须具有非负 integer `index`。按 index：

- 首个 nonempty ID/name 锁定；
- 后续相同值接受，不同值失败；
- arguments 只接受 string fragment；
- 各 index 独立累积。

Tools 不提前输出为 `done:false`。收到 `Done` 时：

1. 按 index 升序；
2. 拼接 arguments；
3. parse 为 ordered JSON object；
4. 构造全部 Ollama tool calls；
5. 与尚未输出的 terminal content/thinking 一起放在唯一 `done:true` object。

### 7.4 Finish、usage 与 terminal

首个 non-null finish reason 锁定。后续不同值不覆盖并视为 upstream inconsistency。

任意 chunk 的 usage 只接受 nonnegative integers，显式 0 必须保留。每个字段 last-valid-wins；
后续 chunk 缺字段不清空已有值。

收到 `Done` 时输出恰好一个 terminal object：

```json
{
  "model": "<original request model>",
  "created_at": "<RFC3339Nano>",
  "message": {
    "role": "assistant",
    "content": "<remaining terminal content>",
    "thinking": "<remaining terminal thinking>"
  },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 12,
  "eval_count": 6
}
```

- finish `length` → `done_reason:"length"`；
- nonempty tool calls → `done_reason:"stop"`；
- missing finish → `"stop"`；
- `content_filter` → `"stop"`；
- unknown 或 tool finish 但没有 tool calls → `upstream_invalid_response`；
- nonempty tool calls 时才输出 `message.tool_calls`；
- missing usage count 固定为 0；
- terminal 后清空 buffers，phase=`finished`；
- 不再输出第二个 terminal 或 error。

`created_at` 在全 stream 使用锁定的同一 time value。

## 8. NDJSON bytes

使用与固定 Ollama DTO 等价的 Go `encoding/json`：

1. root field order：
   `model,remote_model,remote_host,created_at,message,done,done_reason,_debug_info,logprobs,`
   `total_duration,load_duration,prompt_eval_count,prompt_eval_duration,eval_count,eval_duration`；
2. message field order：
   `role,content,thinking,images,tool_calls,tool_name,tool_call_id`；
3. tool call：`id,function`；
4. function：`index,name,arguments`；
5. `omitempty` fields 完全省略；
6. compact UTF-8 JSON，每 object 后一个 LF；
7. Go default HTML escaping：`<`、`>`、`&` 以及 U+2028/U+2029 转义；
8. string/control escaping、number formatting 和 invalid value failure 匹配 Go `encoding/json`；
9. ordered tool arguments 保持输入 member order；
10. 最后一行也必须有 LF，无 BOM/CR/空行。

Error object 只有：

```json
{"error":"<safe text>"}
```

## 9. Error boundary

Ollama wire error shape固定为 `{"error":"<safe text>"}`：

| Error | HTTP status | Safe text |
|---|---:|---|
| `invalid_request` | 400 | `invalid request` |
| `unsupported_semantics` | 422 | `unsupported semantics` |
| `upstream_http_error` | upstream 400..599 status | `upstream request failed` |
| `upstream_timeout` | 504 | `upstream timeout` |
| `upstream_stream_error` | 502 | `upstream stream error` |
| `upstream_invalid_response` | 502 | `invalid upstream response` |
| `upstream_stream_truncated` | 502 | `upstream stream truncated` |
| `invalid_tool_arguments` | 502 | `invalid tool arguments` |
| `invalid_logprobs` | 502 | `invalid logprobs` |
| `internal_error` | 500 | `internal error` |

- Request 尚未转发时的错误返回单个 JSON error body；
- streaming response 尚未开始时返回普通 HTTP error；
- 已输出 NDJSON 后只追加一个 NDJSON error object并关闭；
- error 后不输出 `done:true`；
- client abort 释放 state且不写 error/done；
- 不向 wire 暴露 credential、header、完整 upstream body 或 tool arguments；
- 不生成旁路 diagnostics。

## 10. 测试要求与完成门槛

### 10.1 Request

- model 必填且无默认；
- stream 缺失为 true；
- role lowercase；
- content/thinking/images；
- JPEG/PNG/WebP 与 invalid base64/unknown magic；
- tool ID/index/object arguments、tool_name/tool_call_id；
- Tool `items` 与固定 schema subset；不存在 `strict`；
- options mapping、array-only stop、unrepresentable options；
- format json/schema；
- think boolean/string；
- logprobs/top_logprobs；
- empty messages load/unload boundary。
- `think:true` 零 upstream call与 422 error。

### 10.2 Nonstream

- unique choice index 0；
- original request model；
- content/reasoning/`<think>`；
- valid/invalid ordered tool arguments；
- stop/length/tool/missing finish；
- usage supplied、partial、missing与 token fallback；
- logprobs；
- nonstream created present/missing/invalid；
- omitted metrics/remote/debug/id。

### 10.3 Stream

- every byte split point through multibyte UTF-8、CRLF、multi-data event；
- usage-only chunk；
- unique choice index 0；
- content + thinking in same chunk；
- parallel sparse tool indexes；
- tools only on `done:true`；
- final content/thinking on terminal；
- first `[DONE]` absorbing；
- duplicate `[DONE]` and post-DONE data ignored；
- EOF residual and no-DONE EOF；
- `content_filter`、unknown finish和无 calls 的 tool finish；
- one terminal/error/client-abort invariant。
- stream 初始化 clock 与忽略 chunk created。

### 10.4 Bytes

Golden 必须由固定 Go DTO reference encoder生成并逐 byte比较：

- field order与 omitempty；
- integer/float；
- `<>&`、U+2028/U+2029、control chars、emoji和中文；
- ordered arguments，包括 integer-like keys；
- each line independently parseable；
- final LF；
- error 与 terminal 互斥。

实现完成必须同时满足：

1. request shape与固定 Ollama input语义一致；
2. response defaults与 LiteLLM兼容规则一致；
3. NDJSON 与固定 Ollama Go encoder逐 byte等值；
4. 首个 `[DONE]` 只 finalize一次并吸收后续输入；
5. 不存在运行时 profile、capability 或 pointer 分支；
6. 目标仓库 tests 更新为本规范预期，不保留旧 behavior snapshot。
