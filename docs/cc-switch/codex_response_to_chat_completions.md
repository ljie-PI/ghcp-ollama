# Codex Responses API 与 Chat Completions 桥接实现规范

> 本文描述仓库在提交 `3217f72596f2d1c0f879f0a05f83803825d9809f`
> 上的实际实现，而不是 OpenAI 官方协议的完整定义。目标是让另一个 agent
> 在不阅读原实现的前提下，能够重写并兼容这条桥接链路。

## 1. 结论与范围

仓库已经实现完整的双向桥接：

1. 客户端向本地代理发送 OpenAI Responses API 请求；
2. 代理把请求端点和 JSON body 转为 OpenAI Chat Completions 格式；
3. 上游返回 Chat Completions JSON 或 SSE；
4. 代理把成功响应、流式事件和错误重新转换为 Responses API 格式。

这里的客户端入口是 `/responses` 或 `/v1/responses`。代码还允许
`/responses/compact` 和 `/v1/responses/compact` 进入同一转换路径。上游目标端点固定为
`/chat/completions`。

本实现不只是字段改名，还包含：

- Responses item 序列到 Chat `messages` 的状态化重组；
- function、namespace、custom、tool_search 四类工具的双向映射；
- reasoning 方言适配；
- 工具结果中的图片、文件和音频迁移；
- `previous_response_id` 驱动的跨请求工具调用历史恢复；
- Chat SSE 到 Responses SSE 的事件状态机；
- 非标准上游错误、伪流式响应和截断流处理；
- token usage、缓存 token、ID 和完成状态归一化。

## 2. 模块边界

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/proxy/providers/codex.rs` | 判断 provider 是否使用 Chat 协议，解析 provider 配置，覆写上游模型，推导 reasoning 能力 |
| `src-tauri/src/proxy/forwarder.rs` | 选择转换路径、恢复历史、改写端点、调用请求转换器、注入 prompt cache key |
| `src-tauri/src/proxy/providers/transform_codex_chat.rs` | 非流式请求和响应的核心双向转换、工具上下文 |
| `src-tauri/src/proxy/providers/streaming_codex_chat.rs` | Chat Completions SSE 到 Responses SSE 的状态机 |
| `src-tauri/src/proxy/providers/codex_responses_sse.rs` | Responses SSE 事件的统一 wire builder |
| `src-tauri/src/proxy/providers/codex_chat_common.rs` | reasoning 提取、`<think>` 分离、Responses tool item 构造 |
| `src-tauri/src/proxy/providers/codex_chat_history.rs` | 跨请求缓存和恢复 function/custom/tool_search call item |
| `src-tauri/src/proxy/handlers.rs` | 响应分流、错误转换、伪流式聚合、响应头重建 |
| `src-tauri/src/proxy/tool_media.rs` | 从文本型 tool output 中抽取原生媒体并迁移到合成 user message |
| `src-tauri/src/proxy/json_canonical.rs` | JSON 稳定序列化、工具参数规范化、长工具名哈希 |

## 3. 启用条件与路由

### 3.1 转换开关

只有同时满足以下条件才启用 Responses -> Chat 桥接：

1. 应用类型是 `Codex` 或 `GrokBuild`；
2. 请求 path（忽略 query）属于：
   - `/responses`
   - `/v1/responses`
   - `/responses/compact`
   - `/v1/responses/compact`
3. 当前 provider 被识别为 Chat Completions provider。

provider 协议识别按以下优先级取第一个可用值：

1. `provider.meta.api_format`
2. `provider.settings_config.api_format`
3. `provider.settings_config.apiFormat`
4. `provider.settings_config.config` TOML 中当前 `model_provider` 对应的
   `model_providers.<name>.wire_api`，否则顶层 `wire_api`
5. `base_url` 或 TOML 中 `base_url` 是否以 `/chat/completions` 结尾

以下 `api_format`/`wire_api` 值忽略大小写并视为 Chat：

```text
chat
chat_completions
chat-completions
openai_chat
openai-chat
openai_chat_completions
```

### 3.2 URL 改写

入口 path 一律改写为 `/chat/completions`，原 query 原样保留。例如：

```text
/v1/responses?beta=true
  -> /chat/completions?beta=true
```

如果 provider `base_url` 已经以 `/chat/completions` 结尾，则把它视为完整 endpoint，
即使 provider 没有显式设置 full URL，也不能再次拼接 endpoint。判断时：

- 忽略首尾空白；
- 忽略 query 和 fragment；
- 忽略末尾 `/`；
- path 后缀比较不区分大小写。

### 3.3 总体数据流

```mermaid
flowchart LR
    A[Responses request] --> B[model mapping]
    B --> C[history enrichment]
    C --> D[build tool context]
    D --> E[Responses to Chat body]
    E --> F[/chat/completions upstream]
    F -->|JSON| G[Chat JSON to Responses JSON]
    F -->|SSE| H[Chat SSE state machine]
    F -->|HTTP error| I[Responses error normalization]
    G --> J[history record]
    H --> K[Responses SSE]
    K --> L[stream history record]
```

## 4. 转换前上下文与预处理

### 4.1 Tool context

请求转换前必须从原始 Responses request 构建一个 `ToolContext`。它同时用于：

- 产生 Chat `tools`；
- 将 Responses namespace 名压平；
- 记录压平名到原始 `{namespace, name}` 的反向映射；
- 在响应方向恢复 custom/tool_search/namespace 类型。

收集来源：

1. 顶层 `tools[]`；
2. 对整个 `input` 递归遍历，在任意 `tool_search_output.tools[]` 中发现的工具。

上下文至少维护：

```text
chat_tools: ordered list
seen_chat_names: set
chat_name -> {kind, original_name, namespace?}
(namespace, original_name) -> chat_name
```

空名字和重复 Chat 名字必须跳过，先出现的定义获胜。

### 4.2 模型覆写

转换前执行 provider 的上游模型选择：

1. 如果请求 `model` 已存在于 `settings_config.modelCatalog.models[].model`，保留该值；
2. 否则使用 provider 配置的默认上游 model；
3. 然后再进行 Responses -> Chat body 转换。

### 4.3 历史恢复

在 body 转换前，用 `previous_response_id` 和 `input` 中的 `call_id` 恢复可能缺失的
call item。详见第 10 节。

### 4.4 Prompt cache key

先保存客户端显式传入的顶层 `prompt_cache_key`，body 转换后再决定是否写入 Chat body。

默认只有以下上游自动允许该字段：

- host 为 `api.openai.com`；
- host 为 `api.kimi.com`，且 path 是 `/coding` 或以 `/coding/` 开头。

`provider.meta.prompt_cache_routing` 可强制控制：

- `enabled`：允许；
- `disabled`：禁止；
- `auto` 或缺失：使用上述 host 规则。

key 优先级：

1. 非空的客户端显式 `prompt_cache_key`；
2. 非空且确实由客户端提供的 session ID；
3. 不写入。代理生成的逐请求 UUID 不能充当 cache key。

## 5. Responses 请求转 Chat 请求

核心函数的逻辑签名可抽象为：

```text
responses_to_chat(body, optional_reasoning_config) -> chat_body | TransformError
```

### 5.1 顶层字段

| Responses 输入 | Chat 输出 | 规则 |
| --- | --- | --- |
| `model` | `model` | 原值复制；通常已在预处理阶段覆写 |
| `instructions` | 首条 `system` message | 字符串直接使用；数组提取元素自身或元素 `.text`，过滤空串后用 `\n\n` 拼接 |
| `input` | `messages` | 见第 5.2 节 |
| `max_output_tokens` | `max_completion_tokens` 或 `max_tokens` | OpenAI o-series model 使用前者，否则使用后者 |
| `max_tokens` | `max_tokens` | 原值复制，若同时存在会覆盖前一步同名值 |
| `max_completion_tokens` | `max_completion_tokens` | 原值复制 |
| `temperature` | 同名 | 原值复制 |
| `top_p` | 同名 | 原值复制 |
| `stream` | 同名 | 原值复制 |
| `reasoning` | provider 方言字段 | 见第 7 节 |
| `tools` | `tools` | 见第 6 节 |
| `tool_choice` | `tool_choice` | 见第 6.6 节 |

以下字段原样透传：

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

未列出的 Responses 顶层字段默认不进入 Chat body，例如：

```text
previous_response_id
store
include
truncation
prompt_cache_key（由转换后专门注入）
```

如果最终没有非空 `tools`，必须删除 `tool_choice` 和 `parallel_tool_calls`，避免严格上游
因“没有工具却指定工具策略”返回 400。

当 `stream == true` 时，必须保证：

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

如果原 `stream_options` 是对象，保留其他键并覆盖 `include_usage=true`；否则替换为上述对象。
非流式请求不能凭空添加 `stream_options`。

### 5.2 `input` 到 `messages`

`input` 可为：

- 字符串：生成一条 `{"role":"user","content":<string>}`；
- 对象：按单个 input item 处理；
- 数组：按顺序处理每个 item；
- 其他类型：不生成消息。

角色归一化：

| Responses role | Chat role |
| --- | --- |
| `system` | `system` |
| `developer` | `system` |
| `assistant` | `assistant` |
| `tool` | `tool` |
| `user` | `user` |
| `latest_reminder` | `user` |
| 未知或缺失 | `user` |

全部 item 转完后，把所有 `system` message 的非空字符串 content 按原出现顺序用
`\n\n` 合并，并移动到 `messages[0]`。非 system message 的相对顺序不能变化。

这条约束是兼容 MiniMax 等只允许首条 system message 的上游。

### 5.3 message/content item

`type == "message"`，或 type 缺失但带 `role`/`content` 的对象，转换为普通 Chat message。
未来未知 type 只要带 `role` 或 `content` 也按 message 处理。

content 规则：

1. `null` 或字符串：原样保留；
2. 非数组、非字符串：原样保留；
3. 数组：逐 part 转换。

part 映射：

| Responses part | Chat part |
| --- | --- |
| `input_text` / `output_text` / `text` | `{"type":"text","text":...}` |
| `refusal` | 当普通 text part，文本取 `.refusal` |
| `input_image` | `{"type":"image_url","image_url":...}`；字符串 URL 包成 `{"url":...}`，对象原样用 |
| `input_file` | `{"type":"file","file":{...}}`；仅复制 `file_id`、`file_data`、`filename` |
| `input_audio` | `{"type":"input_audio","input_audio":...}` |
| 其他 | 丢弃 |

如果转换结果没有任何非文本 part，则不要返回 part 数组，而要把所有 text 用单个 `\n`
连接成 Chat 字符串。只要存在 image/file/audio，则保留整个 part 数组。

顶层 `type` 为 `input_text`、`input_image`、`input_file`、`input_audio` 的 item，
视为只有一个 part 的独立 message；role 仍按上表处理，缺失时为 user。

`input_file` 只有 `file_id` 或 `file_data` 至少存在一个时才有效；仅有 URL 的文件 part 被丢弃。

### 5.4 call item 和 call output

连续的 call item 必须先缓存为一个批次，最终生成一条：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": []
}
```

批次在遇到 output、普通 message、特定边界 item 或 input 结束时 flush。

`function_call`：

```text
id = call_id，缺失时回退 item.id，再缺失为空串
function.name = namespace 映射后的 Chat 名
function.arguments = 规范化后的 JSON 字符串
```

`custom_tool_call`：

```text
id = call_id -> item.id -> ""
function.name = item.name -> ""
function.arguments = canonical JSON {"input": item.input 或 ""}
```

`tool_search_call`：

```text
id = call_id -> item.id -> ""
function.name = "tool_search"
function.arguments = item.arguments 的 canonical JSON；缺失为 "{}"
```

`function_call_output` 生成：

```json
{
  "role": "tool",
  "tool_call_id": "<call_id-or-empty>",
  "content": "<string>"
}
```

content 规则：

- output 是字符串且能解析为 JSON：解析后按 canonical JSON 重新序列化；
- output 是普通字符串：原样保留；
- output 是其他 JSON：canonical JSON；
- output 缺失：空串。

`custom_tool_call_output` 和 `tool_search_output` 也生成 tool message，但 content 是整个原始
item 的 canonical JSON，而不只是 `.output`。媒体迁移时使用替换过媒体的整个 item。

### 5.5 JSON canonicalization

canonical JSON 必须：

- 对象 key 按字典序排序；
- 数组保序；
- 不添加多余空白；
- 递归处理嵌套对象。

工具 `arguments` 额外遵循：

- 缺失、空串或纯空白串 -> `"{}"`；
- JSON 字符串 -> 解析并 canonicalize；
- 无法解析的普通字符串 -> 原样保留；
- object/array/scalar -> canonical JSON 字符串。

### 5.6 Reasoning 在历史 message 中的归属

Responses 历史可能把 reasoning 单独作为 item，也可能把它嵌在 message/call item 内。
Chat 历史则要求它成为 assistant message 的 `reasoning_content`。

reasoning 文本提取优先级：

1. 非空 `reasoning_content` 字符串；
2. 非空 `reasoning` 字符串；
3. `reasoning.content`、`reasoning.text`、`reasoning.summary`；
4. `reasoning_details`：
   - 字符串；
   - 对象的 `text`、`content`、`summary`；
   - 数组或对象 `parts[]`，各段用 `\n\n` 连接。

独立 `type=="reasoning"` item 的提取规则稍有不同：

1. `reasoning_content`、`content`、`text`；
2. `summary` 字符串；
3. `summary[]` 中 part 的 `.text`、`.content` 或 part 自身字符串，用 `\n\n` 连接。

归属状态机：

1. 独立 reasoning 先进入 `pending_reasoning`；
2. 后续 assistant message 或 call 批次优先消费 pending reasoning；
3. 多段 reasoning 用 `\n\n` 追加；
4. call item 自带的 reasoning 只在 pending 中尚未包含相同文本时追加；
5. 到 user 等非 assistant 回合边界，尚未消费的 reasoning 回填到上一条 assistant，
   然后清空，禁止跨 user 回合泄漏；
6. input 结束时剩余 reasoning 同样回填到上一条 assistant；
7. assistant message 同时有 embedded 和 trailing reasoning 时，以 `\n\n` 拼接；
8. 每条带非空 `tool_calls` 但没有非空 reasoning 的 assistant message，最后补
   `reasoning_content: "tool call"`。

第 8 条是 Kimi/Moonshot、DeepSeek thinking 模型兼容要求，不能省略。

### 5.7 Tool output 媒体迁移

Chat tool message 是文本，但 Responses tool output 可能含图片、文件或音频。实现必须：

1. 递归扫描 tool output，最大深度 32；
2. 把识别出的媒体块替换为：
   `[cc-switch: tool result media moved to the following user message]`；
3. 保留 tool message 的文本/JSON 骨架；
4. 把媒体按 call 顺序积累；
5. 在当前并行 tool outputs 全部发完后，插入合成 user message：

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "[cc-switch: media output of tool call <call_id>]"
    },
    "<native Chat media parts...>"
  ]
}
```

多个并行 tool output 的媒体合并进同一条 user message，但每个 call 前都要有对应标记。
媒体必须在下一批 assistant tool_calls 或真实 user message 之前 flush。

支持的媒体输出至少包括：

- Responses/Chat image URL 形态；
- Anthropic `{"type":"image","source":{"media_type":...,"data":...}}`；
- MCP `{"type":"image","mimeType":...,"data":...}`；
- `input_file`，且含 `file_id` 或 `file_data`；
- `input_audio.input_audio`；
- 整个字符串就是图片 data URL，且 trim 后至少 8 KiB；
- JSON 编码字符串中的上述结构。

不能把嵌在 HTML/CSS/SVG 文本中的 data URL 当媒体，也不能把小 data URL 自动迁移。
只有确定发现媒体后，才把残留的超长 data/base64-like 字符串替换为：

```text
[cc-switch: omitted <byte_len> bytes]
```

无媒体的输出必须保持既有字符串/canonical JSON 语义，不得额外包一层 JSON 引号。

## 6. 工具声明和选择

### 6.1 普通 function

兼容两种 Responses 声明：

```json
{"type":"function","name":"f","description":"...","parameters":{},"strict":true}
```

```json
{"type":"function","function":{"name":"f","description":"...","parameters":{}},"strict":true}
```

统一输出：

```json
{
  "type": "function",
  "function": {
    "name": "f",
    "description": "...",
    "parameters": {},
    "strict": true
  }
}
```

`parameters` 必须是 object schema：

- 缺失、null、非对象 -> `{"type":"object","properties":{}}`；
- 对象但 `.type` 不是字符串 `"object"` -> 保留其他键并强制 `.type="object"`；
- 顶层 `oneOf` 等其他 schema 键必须保留。

嵌套 function 中已有 `strict` 优先；否则从 tool 顶层补入。

### 6.2 Namespace tool

Responses namespace：

```json
{
  "type": "namespace",
  "name": "ns",
  "tools": [{"type":"function","name":"f"}]
}
```

也接受 child 数组键 `children`。只处理其中 `type=="function"` 的 child。

Chat function name：

```text
ns + "__" + f
```

如果 UTF-8 字节长度不超过 64，直接使用。如果超过 64：

1. 对完整名字做 SHA-256；
2. 取 digest 前 8 字节，编码为 16 个小写 hex 字符；
3. suffix 为 `"__" + hex`；
4. 从原名取不切断 UTF-8 字符的最长前缀，使 `prefix + suffix` 总字节数不超过 64。

反向响应转换必须依赖 ToolContext 恢复原始 `namespace` 和 `name`，不能尝试仅靠
`__` 拆字符串，因为名字可能含 `__` 或已被哈希截断。

### 6.3 Custom tool

字符串形式的 tool 名也视为 custom tool。custom tool 被包装成 Chat function：

```json
{
  "type": "function",
  "function": {
    "name": "<custom name>",
    "description": "Original tool definition:\n```json\n<canonical original tool JSON>\n```",
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

原始 custom tool 的 description、format、grammar 等元数据通过 description 中的 canonical
JSON 完整保留。

### 6.4 Tool search

Responses `{"type":"tool_search"}` 固定包装为名为 `tool_search` 的 Chat function，
参数 schema：

```json
{
  "type": "object",
  "properties": {
    "query": {"type":"string"},
    "limit": {"type":"integer"}
  },
  "required": ["query"]
}
```

### 6.5 Tool context 的反向类型恢复

Chat tool call 的 function name 查 ToolContext：

| Context kind | Responses 输出 |
| --- | --- |
| function | `function_call` |
| namespace | 带原始 `namespace` 的 `function_call` |
| custom | `custom_tool_call` |
| tool_search | `tool_search_call` |
| 未找到 | 普通 `function_call`，name 保留 Chat name |

### 6.6 `tool_choice`

| Responses choice | Chat choice |
| --- | --- |
| `{"type":"function","name":"f","namespace":"ns"?}` | `{"type":"function","function":{"name":"<mapped name>"}}` |
| `{"type":"tool_search"}` | 指定 `tool_search` function |
| `{"type":"custom","name":"x"}` | 指定名为 `x` 的 function |
| 其他字符串/对象 | 原样复制 |

如果最终没有工具，整个 `tool_choice` 会被删除，包括字符串 `"none"`。

## 7. Reasoning 请求方言

reasoning 配置结构：

```text
supportsThinking?: bool
supportsEffort?: bool
thinkingParam?: "thinking" | "enable_thinking" | "reasoning_split" | "none"
effortParam?: "reasoning_effort" | "reasoning.effort" | "none"
effortValueMode?: "passthrough" | "deepseek" | "low_high" | "openrouter" | "zen"
outputFormat?: descriptive only
effort_levels?: runtime-only model-specific list
```

`outputFormat` 当前不参与响应提取；响应侧始终穷举已知字段。

### 7.1 是否请求 reasoning

- `reasoning.effort` 是 `none`、`off`、`disabled`（忽略大小写和空白）-> 显式 false；
- 存在其他字符串 effort -> true；
- 否则，存在 `reasoning` 键时，值非 null -> true，null -> false；
- 完全没有 `reasoning` -> 未指定，不能主动添加 reasoning 字段。

### 7.2 Thinking 开关

如果 provider 支持 thinking：

| `thinkingParam` | true | false |
| --- | --- | --- |
| `thinking` | `{"thinking":{"type":"enabled"}}` | `{"thinking":{"type":"disabled"}}` |
| `enable_thinking` | `{"enable_thinking":true}` | `{"enable_thinking":false}` |
| `reasoning_split` | `{"reasoning_split":true}` | `{"reasoning_split":false}` |
| 其他/none | 不写 |

`supportsEffort=true` 且 `supportsThinking` 缺失时，按支持 thinking 处理。

### 7.3 Effort 映射

只有显式启用 reasoning 且 provider 支持 effort 时才映射。

| mode | 映射 |
| --- | --- |
| `passthrough` | 仅接受 `minimal/low/medium/high/xhigh/max/ultra`，原值输出 |
| `deepseek` | `max/xhigh/ultra -> max`；其他可识别请求统一 `high` |
| `low_high` | `minimal/low -> low`；其他可识别请求统一 `high` |
| `openrouter` | `max/xhigh/ultra -> xhigh`；其余只接受 `high/medium/low/minimal` |
| `zen` | 使用模型 `reasoningLevels`；选择“不低于请求档位的最近合法档”，超过最高则选最高；无表或未知请求值则不写 |

档位排序：

```text
minimal < low < medium < high < xhigh < max < ultra
```

输出位置：

- `effortParam=="reasoning_effort"` -> 顶层 `reasoning_effort`；
- `effortParam=="reasoning.effort"` -> `{"reasoning":{"effort":...}}`。

显式关闭时，只有 `reasoning.effort` 方言要输出：

```json
{"reasoning":{"effort":"none"}}
```

顶层 `reasoning_effort` 方言不输出 `none`，只走 thinking 关闭开关。

若没有 provider reasoning 配置，则只对内置判断为支持 effort 的 model，把
`reasoning.effort` 原样复制到顶层 `reasoning_effort`。

### 7.4 自动推导

显式 `provider.meta.codexChatReasoning` 优先。否则先按平台 name/base URL 推导，再按
provider/model 关键词推导。平台规则必须优先于模型厂商规则：

| 平台/模型 | thinking 字段 | effort | 响应字段提示 |
| --- | --- | --- | --- |
| OpenRouter | 无 | `reasoning.effort`, mode=openrouter | auto |
| SiliconFlow | `enable_thinking` | 不支持 | `reasoning_content` |
| ModelScope | `enable_thinking` | 不支持 | `reasoning_content` |
| opencode.ai Zen | 无 | `reasoning_effort`, mode=zen | `reasoning_content` |
| DeepSeek | `thinking` | `reasoning_effort`, mode=deepseek | `reasoning_content` |
| StepFun | 无开关 | 部分模型支持，2603 用 low_high，3.7 用 passthrough | `reasoning` |
| Kimi/Moonshot | `thinking` | 不支持 | `reasoning_content` |
| GLM/Zhipu/z.ai | `thinking` | 不支持 | `reasoning_content` |
| Qwen/DashScope/Bailian | `enable_thinking` | 不支持 | `reasoning_content` |
| MiniMax | `reasoning_split` | 不支持 | `reasoning_details` |
| MiMo | `thinking` | 不支持 | `reasoning_content` |

## 8. 非流式 Chat 响应转 Responses 响应

抽象签名：

```text
chat_completion_to_response(chat_body, tool_context) -> responses_body | TransformError
```

### 8.1 输入校验

必须存在非空 `choices` 数组，并使用第一项：

- 缺 `choices` -> `No choices in chat response`；
- 空数组 -> `Empty choices in chat response`；
- 第一项缺 `message` -> `No message in chat choice`。

这里只支持单选择语义，其他 choice 被忽略。

### 8.2 顶层 envelope

```json
{
  "id": "<normalized>",
  "object": "response",
  "created_at": 0,
  "status": "completed",
  "model": "",
  "output": [],
  "usage": {}
}
```

字段规则：

- `id`：Chat ID 以 `resp_` 开头则原样使用，否则前缀 `resp_`；缺失时为
  `resp_ccswitch`；
- `created_at`：取 Chat `created` 的无符号整数，缺失为 0；
- `model`：取 Chat `model` 字符串，缺失为空串；
- `status`：仅 `finish_reason=="length"` 映射为 `incomplete`，其他值和缺失都为
  `completed`；
- incomplete 时添加：
  `{"incomplete_details":{"reason":"max_output_tokens"}}`。

### 8.3 `output` 顺序

固定按以下顺序追加：

1. reasoning item（若有）；
2. assistant message item（若有可见 content/refusal）；
3. tool call items（按 Chat 数组顺序）。

reasoning item：

```json
{
  "id": "rs_<response_id>",
  "type": "reasoning",
  "summary": [{"type":"summary_text","text":"..."}]
}
```

非流式完成 reasoning item 没有 `status`。

assistant message item：

```json
{
  "id": "<response_id>_msg",
  "type": "message",
  "status": "completed",
  "role": "assistant",
  "content": []
}
```

content 映射：

- Chat 字符串 content -> 一个 `output_text`；
- Chat content 数组中的 `text`/`output_text` -> `output_text`；
- 数组中的 `refusal` -> Responses `refusal`；
- message 顶层非空 `refusal` -> 再追加一个 Responses `refusal`；
- `output_text` 固定带 `annotations: []`；
- 没有任何有效 part 时不生成 message item。

### 8.4 Reasoning 响应提取

先按第 5.6 节的 alias 优先级从 Chat message 提取。若没有，再检查字符串 content 是否
以可选空白加 `<think>` 开头，并且存在 `</think>`：

```text
<think>reasoning</think>answer
```

- 中间内容 trim 后成为 reasoning summary；
- 结束标签后的开头空白被剥掉，剩余成为 assistant answer；
- 标签本身不得泄漏到 Responses 输出；
- 没有完整结束标签时，非流式转换不把它拆成 reasoning。

### 8.5 Tool call 响应

支持现代 `message.tool_calls[]` 和 legacy `message.function_call`。

普通 function/namespace：

```json
{
  "id": "fc_<call_id>",
  "type": "function_call",
  "status": "completed",
  "call_id": "<call_id>",
  "name": "<restored name>",
  "namespace": "<only when namespace>",
  "arguments": "<canonical JSON or original non-JSON string>",
  "reasoning_content": "<optional>"
}
```

custom：

```json
{
  "id": "ctc_<call_id>",
  "type": "custom_tool_call",
  "status": "completed",
  "call_id": "<call_id>",
  "name": "<original custom name>",
  "input": "<decoded input>",
  "reasoning_content": "<optional>"
}
```

custom input 解码：

- arguments 为空 -> 空串；
- arguments 是 JSON object 且 `.input` 是字符串 -> 取 `.input`；
- 否则返回原始 arguments 字符串。

tool_search：

```json
{
  "type": "tool_search_call",
  "call_id": "<call_id>",
  "status": "completed",
  "execution": "client",
  "arguments": {},
  "reasoning_content": "<optional>"
}
```

tool_search arguments：

- 空串 -> `{}`；
- 能解析且结果为 object -> 该 object；
- 否则 -> `{"query":"<raw arguments>"}`。

Chat call ID 缺失时，现代数组按 index 合成 `call_<index>`，legacy 使用 `call_0`。

函数名缺失或 trim 后为空时丢弃该 call。若：

- 本轮 status 本应是 `completed`；
- 至少丢弃一个无合法名字的 call；
- 最终一个合法 tool call 都没有；

则整个非流式转换失败，错误说明上游返回无函数名的 tool call。若仍有至少一个合法 call，
只丢弃坏 call；若 `finish_reason=="length"`，保持 incomplete 而不报该错误。

### 8.6 Usage

缺 usage 时也必须返回全零对象：

```json
{
  "input_tokens": 0,
  "input_tokens_details": {"cached_tokens": 0},
  "output_tokens": 0,
  "total_tokens": 0,
  "output_tokens_details": {"reasoning_tokens": 0}
}
```

基础映射：

| Chat usage | Responses usage |
| --- | --- |
| `prompt_tokens`，回退 `input_tokens` | `input_tokens` |
| `completion_tokens`，回退 `output_tokens` | `output_tokens` |
| `total_tokens` | `total_tokens`；缺失则 input + output |

cache read 优先级：

1. 顶层 `cache_read_input_tokens`
2. `prompt_tokens_details.cached_tokens`
3. `input_tokens_details.cached_tokens`
4. DeepSeek `prompt_cache_hit_tokens`
5. 0

cache write 优先级：

1. `prompt_tokens_details.cache_write_tokens`
2. `input_tokens_details.cache_write_tokens`
3. 顶层 `cache_creation_input_tokens`
4. 0

输出总是有 `input_tokens_details.cached_tokens`。cache write 大于 0 时同时写
`input_tokens_details.cache_write_tokens` 和顶层 `cache_creation_input_tokens`。
如果输入直接带 `cache_read_input_tokens`，输出也保留该顶层字段。

`completion_tokens_details` 是对象时整体复制，并在缺失时补
`reasoning_tokens: 0`；否则创建只含该零值的对象。

## 9. Chat SSE 转 Responses SSE

### 9.1 输入解析

输入按 SSE block 解析：

- 支持任意 bytes 分片和跨分片 UTF-8；
- 一个 block 中多个 `data:` 行用 `\n` 连接；
- `event:` 可选；
- 空 block 和无 data block 忽略；
- `data: [DONE]` 触发 finalize；
- 无法解析为 JSON 的普通 data block直接忽略；
- `event:error` 或 chunk 中存在 `error` 键时转为 `response.failed` 并终止。

每个 Chat chunk：

1. 若有 `id`，归一化为 Responses ID；
2. 若有非空 `model`，覆盖当前 model；
3. 若有无符号 `created`，覆盖当前 created_at；
4. 确保先发 response 生命周期起始事件；
5. 非 null usage 覆盖 `latest_usage`；
6. 只处理 `choices[0]`；
7. delta 的 reasoning、content、tool_calls 依次处理；
8. 非空 `finish_reason` 保存为最终原因。

### 9.2 Response 起始和结束

第一次处理有效 JSON chunk 时依次发：

```text
response.created
response.in_progress
```

两者 data 形状分别为：

```json
{"type":"response.created","response":{...}}
{"type":"response.in_progress","response":{...}}
```

此时 response：

```json
{
  "id": "<current response id>",
  "object": "response",
  "created_at": 0,
  "status": "in_progress",
  "model": "",
  "output": [],
  "usage": "<latest usage or zero usage>"
}
```

正常结束只发一个 `response.completed`，其 `response.output` 包含所有已完成 item，并按
`output_index` 排序。即使 response status 是 `incomplete`，SSE event 名仍是
`response.completed`。

失败只发 `response.failed`，response `status=="failed"` 且带：

```json
{"error":{"message":"...","type":"<optional>"}}
```

失败后不能再发 `response.completed`。

### 9.3 文本事件序列

首段可见文本：

```text
response.output_item.added
response.content_part.added
response.output_text.delta  (每个增量)
```

added item：

```json
{
  "id": "<response_id>_msg",
  "type": "message",
  "status": "in_progress",
  "role": "assistant",
  "content": []
}
```

content part 固定：

```json
{"type":"output_text","text":"","annotations":[]}
```

结束时：

```text
response.output_text.done
response.content_part.done
response.output_item.done
```

done item 与非流式 message item 相同，包含完整累计文本。

### 9.4 Reasoning 事件序列

reasoning delta 使用与非流式相同的 alias 提取。首段：

```text
response.output_item.added
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
```

added reasoning item：

```json
{
  "id": "rs_<response_id>",
  "type": "reasoning",
  "status": "in_progress",
  "summary": []
}
```

summary part：

```json
{"type":"summary_text","text":""}
```

结束时：

```text
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done
```

最终 reasoning item 不带 status。

如果 content 流以可选空白加 `<think>` 开头，流式状态机先缓冲，直到能判断：

- 是 `<think>` 前缀：标签内 content 转 reasoning；
- 确认不是此前缀：全部转普通文本；
- 收到 `</think>`：关闭 reasoning，标签后内容转文本；
- 流结束或工具边界前仍未闭合：剥开头 `<think>` 后把剩余缓冲当 reasoning。

显式 reasoning delta 会被同时附到当前尚未 done 的 tool call，保留工具调用历史思考。

### 9.5 Tool call 流状态

每个 Chat tool index 维护：

```text
output_index?
item_id
call_id
name
arguments accumulator
reasoning_content
added
done
```

索引规则：

- 有 `tool_call.index`：使用该整数；
- 无 index 但 id 与已有 call 匹配：使用已有 key；
- 无 index且出现新的非空 id：在最后 key 后分配新 key；
- 无 index、无 id：归入最后 key，空 map 时为 0；
- key 加一溢出时归入最后 key；
- 稀疏 index 必须支持，不能用按 index 扩容的稠密数组。

空 id/name continuation delta 不能覆盖已保存的非空 identity。arguments 字符串按到达顺序拼接。

为了防止晚到的早期 call name 导致并行工具重排，只有从
`next_tool_index_to_add` 开始连续、且 call_id/name 都已具备的 call 才提前发 added。
finalize 时仍必须处理非连续的稀疏 key。

普通 function 首次可发：

```text
response.output_item.added
response.function_call_arguments.delta  (0..N)
```

结束：

```text
response.function_call_arguments.done
response.output_item.done
```

custom tool 不发送 function arguments 事件。结束时从累计 arguments 解包 `.input`，发送：

```text
response.custom_tool_call_input.delta  (仅 input 非空时)
response.custom_tool_call_input.done
response.output_item.done
```

工具 arguments 在 done item 和 done event 中必须 canonicalize。

无合法函数名的 call 在 finalize 时丢弃。与非流式相同：

- completed 回合中所有 call 都因无名字被丢弃 -> `response.failed`，
  type=`upstream_tool_call_dropped`；
- 仍有合法 call -> 只丢弃坏 call；
- length/incomplete -> 不转为该失败。

### 9.6 流终止判定

1. 收到 `[DONE]`：finalize；
2. 字节流自然结束且已经 completed，或已见 `finish_reason`：finalize/不重复 finalize；
3. 自然结束、无 finish reason、但已有实质输出：强制按 `length` finalize，返回
   incomplete + `max_output_tokens`；
4. 自然结束、无 finish reason、且无任何实质输出：`response.failed`，
   type=`stream_truncated`；
5. 底层 stream error：`response.failed`，type=`stream_error`；
6. SSE error event：提取 `.error.message`/`.error.detail` 或顶层对应字段，type 优先
   `.type`，回退 `.code`。

## 10. 跨请求工具历史

### 10.1 必要性

Codex 后续请求可能只发送：

```json
{
  "previous_response_id": "resp_x",
  "input": [{
    "type": "function_call_output",
    "call_id": "call_1",
    "output": "..."
  }]
}
```

Chat thinking provider 通常要求 tool output 之前存在原 assistant tool call，且保留
`reasoning_content`。因此代理必须缓存上一响应的 call item 并在下次请求补回。

### 10.2 缓存模型

- 最多缓存 512 个 response；
- 按 response 插入顺序淘汰最旧 response；
- 每个 response 保存 `call_id -> item` 和原 call 顺序；
- 全局维护 `call_id -> response_id 列表`；
- 只缓存：
  - `function_call`
  - `custom_tool_call`
  - `tool_search_call`
- call ID 提取优先 `call_id`，回退 `id`，trim 后必须非空。

非流式转换成功后，从完整 Responses response 记录。
流式路径监听已转换后的 `response.output_item.done` 和 `response.completed` 事件记录。

### 10.3 请求 enrich

只处理 object/array 形式的 `input`；字符串等原样保留。

lookup 顺序：

1. `previous_response_id` 对应 response；
2. 对该 response 未命中的请求 call_id，只有全局缓存中恰好唯一匹配一个 response 时，
   才允许 fallback；
3. 同一 call_id 对应多个 response 时禁止猜测。

恢复规则：

- output 前缺失对应 call item：在第一条 call output 前按原 call 顺序插入整个匹配组；
- 后续单独遇到未恢复的 output：在它前面插入对应 cached call；
- 请求已带 call item：不重复插入；
- 请求已有 call item 但部分字段为空，从缓存补以下字段：
  `name`、`namespace`、`arguments`、`input`、`status`、`execution`、
  `reasoning_content`、`reasoning`；
- 请求中的非空字段永远优先，缓存不能覆盖。

如果原 `input` 是单对象且没有发生恢复/补全，保持对象形态；发生变化后可转成数组。

## 11. 非流请求收到 SSE 的兼容聚合

如果客户端 `stream:false`，但上游 body 无法解析为 JSON且内容看起来像 SSE，handler 会先
把 Chat SSE 聚合为一个 `chat.completion`，再走第 8 节。

聚合必须：

- 剥离开头 UTF-8 BOM；
- 支持 CRLF、最后 block 无空行、多 data 行；
- 只聚合 choice index 0；
- id/created/model 取首个“有意义”值，null、空串和数值 0/0.0 不算；
- usage 取最后一个非 null 值；
- finish_reason 取第一个非 null 值；
- content/refusal 追加；
- reasoning 使用统一 alias 提取器追加；
- tool_calls 用稀疏有序 map 按 index 聚合，id/name 非空时覆盖，arguments 分片追加；
- arguments 为 object/array 时序列化后追加；
- legacy `function_call` 转为 index 0 的 synthetic tool call；
- 如果存在非空 `message` 快照且 `delta` 为空，用 message 覆盖此前累计内容；
- `event:error` 无条件失败；
- 普通 chunk 的 `error` 只有能提取出非空消息时才失败，null/空占位不能误杀；
- 完全没见到 choice -> 失败；
- 同时缺 finish_reason 和 `[DONE]` -> 判定截断并失败；
- 有 `[DONE]` 时可以接受缺 finish_reason；
- 缺响应 id 时生成 UUID；
- 未结束的残余 JSON block 可忽略，不能推翻此前已完成响应。

这条 fallback 聚合与真正流式状态机是两个独立实现；重写时必须为二者保留一致的
reasoning、tool call 和截断语义。

## 12. 错误转换与 HTTP 响应

上游非 2xx Chat 响应保留原 HTTP status，但 body 统一为：

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "code": null,
    "param": null
  }
}
```

输入兼容：

1. 标准 `{"error":{...}}`；
2. 顶层错误对象；
3. MiniMax `base_resp.status_code/status_msg`；
4. 顶层 `message`、`detail`、`status_msg`；
5. JSON 字符串；
6. 非 JSON/HTML/纯文本；
7. 空 body。

提取：

- message：`message -> detail -> status_msg -> base_resp.status_msg -> source 字符串 ->
  整个 source JSON 字符串`；
- type：`type`，缺失为 `upstream_error`；
- code：`code -> base_resp.status_code -> null`；
- param：`param -> null`；
- 空 body message：`Upstream returned an empty error response`。

非 JSON HTTP 错误最多保留 1024 bytes 的 UTF-8 lossily decoded 文本，按字符边界截断并加
`…(truncated)`。

重建 JSON 响应时：

- 保留原 status；
- 移除旧实体相关 header 和 hop-by-hop header；
- 移除上游 `Content-Type`，设置唯一
  `Content-Type: application/json`。

流式成功响应设置：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
```

非流式成功响应保留可安全透传的上游 header，并把 Content-Type 重建为
`application/json`。

## 13. 重写建议的内部接口

为避免逻辑互相污染，建议至少保留以下组件边界：

```text
detect_bridge(provider, app_type, endpoint) -> bool
rewrite_endpoint(endpoint, base_url) -> url

build_tool_context(responses_request) -> ToolContext
enrich_request_from_history(request, HistoryStore) -> mutation_count
responses_request_to_chat(request, ToolContext, ReasoningConfig?) -> ChatRequest

chat_response_to_responses(response, ToolContext) -> ResponsesResponse
chat_sse_to_responses(stream, ToolContext) -> ResponsesEventStream
chat_error_to_responses(status, headers, body) -> HttpResponse

record_response_history(response)
record_response_event_history(event)
```

请求方向伪代码：

```text
if bridge_enabled:
    explicit_cache_key = request.prompt_cache_key
    history.enrich(request)
    apply_upstream_model(request)
    reasoning_config = resolve_reasoning_config(provider, request.model)
    tool_context = build_tool_context(request)
    chat_request = convert_request(request, tool_context, reasoning_config)
    maybe_inject_prompt_cache_key(chat_request, explicit_cache_key, client_session_id)
    POST rewritten_chat_url with chat_request
```

响应方向伪代码：

```text
if upstream_status is not 2xx:
    return normalize_chat_error(upstream_status, upstream_headers, upstream_body)

if client_requested_stream or upstream_is_sse:
    responses_stream = convert_chat_sse(upstream_stream, tool_context)
    return record_history_while_passthrough(responses_stream)

chat_json = parse_json(upstream_body)
if parse_failed and body_looks_like_sse:
    chat_json = aggregate_chat_sse(upstream_body)
responses_json = convert_chat_json(chat_json, tool_context)
history.record(responses_json)
return responses_json
```

## 14. 必须保持的实现不变量

1. ToolContext 必须从请求产生，并同时传给请求和响应转换；否则 namespace/custom/tool_search
   无法无损恢复。
2. tool arguments 和 tool outputs 的 canonical JSON 必须稳定，否则会破坏 prompt cache。
3. system message 最终只能位于 `messages[0]`。
4. assistant tool-call history最终必须有非空 `reasoning_content`。
5. tool output 必须紧跟对应 assistant tool_calls；迁移出的媒体不能插在并行 tool outputs
   之间。
6. namespace Chat name 必须不超过 64 UTF-8 bytes，长名映射必须确定性。
7. 无 tools 时不能保留 `tool_choice` 或 `parallel_tool_calls`。
8. 流式 output index 必须按逻辑产出顺序单调分配，最终 output 按该 index 排序。
9. SSE 只能终结一次；failed 后不能 completed。
10. `finish_reason=length` 必须表示 incomplete，不能被无名工具调用错误覆盖。
11. completed 回合如果所有工具调用都因无名字被丢弃，必须显式失败，不能返回“成功空壳”。
12. 缺 usage 仍输出完整全零 usage schema，但消费记录层应跳过全零 usage。
13. 历史 fallback 只能使用全局唯一 call_id，不能在歧义时猜测。
14. 未知 Responses input item 只有带 role/content 时才按 message 保留；否则不能生成幽灵消息。
15. 非流式入口遇到伪 SSE 时必须聚合，不能直接把 Chat SSE 透传给 Responses 客户端。

## 15. 最小验收测试矩阵

重写实现至少应覆盖以下契约测试：

| 类别 | 用例 | 预期 |
| --- | --- | --- |
| 路由 | 四种 Responses path + query | 都转 `/chat/completions` 且 query 保留 |
| provider 检测 | 每种 api_format alias | 启用桥接 |
| 基础请求 | instructions + string input | system + user |
| 角色 | developer/latest_reminder/未知 | system/user/user |
| system | 中途多个 developer | 合并到首条，其他消息保序 |
| 多模态 | text + image + file + audio | Chat part 数组正确 |
| token limit | o-series 与普通 model | 分别使用 max_completion_tokens/max_tokens |
| streaming request | 原 stream_options 存在/不存在 | 合并 include_usage=true |
| 无工具 | 有 tool_choice/parallel_tool_calls | 两字段删除 |
| function schema | null/missing/non-object type/oneOf | 强制 object 且保留其他键 |
| namespace | 短名、超过 64 bytes、多字节字符 | 确定性压平和反向恢复 |
| custom | grammar 元数据、freeform input | 描述保留原定义，input 往返无损 |
| tool_search | 加载 namespace 后调用 | 恢复 tool_search 和 namespace |
| reasoning history | 前置、尾随、embedded+尾随、跨 user 边界 | 归属正确且不泄漏 |
| reasoning placeholder | 裸 assistant tool_calls | `"tool call"` |
| tool history | previous_response_id + output only | 自动插入原 call 和 reasoning |
| history fallback | 唯一/歧义 call_id | 仅唯一时恢复 |
| tool media | 单个、并行、下一批 call、真实 user 边界 | tool outputs 相邻，媒体位置正确 |
| non-stream text | reasoning + answer + calls | output 顺序 reasoning/message/calls |
| inline think | `<think>...</think>answer` | 标签消失，reasoning/answer 分离 |
| usage | cache read/write 四种别名 | 按优先级归一化 |
| finish reason | stop/tool_calls/length | completed/completed/incomplete |
| malformed call | 仅无名、混合、length 截断 | error/保留合法/incomplete |
| SSE text | 多 delta + usage-only final chunk | 完整生命周期和 usage |
| SSE tools | identity/arguments 分帧、并行、稀疏/缺 index | 不重排、不丢参数、不稠密扩容 |
| SSE custom | arguments 中 input 分片 | custom input delta/done |
| SSE truncation | 有输出无 finish、无输出无 finish | incomplete / failed |
| SSE error | event:error、transport error | failed 且不再 completed |
| fake SSE | stream:false 返回 message snapshot | 聚合后返回 Responses JSON |
| HTTP error | OpenAI、MiniMax、纯文本、HTML、空 body | 标准 Responses error，status 保留 |
