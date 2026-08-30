# Native Responses 与 Anthropic Models 调研

## 1. 范围与来源

本文回答两个问题：

1. OpenAI Responses 请求何时可以直接调用上游 `/responses`，而不是转换为
   `/chat/completions`；
2. LiteLLM Proxy 如何在模型列表接口返回 Anthropic-compatible shape，以及当前 ghcp-gateway
   文档是否覆盖。

固定源码：

| Repository | Commit |
| --- | --- |
| `BerriAI/litellm` | `ae7e50f096a8722bad14d63b6a0d4634d59bf475` |
| `farion1231/cc-switch` | `3217f72596f2d1c0f879f0a05f83803825d9809f` |
| `ljie-PI/ghcp-ollama` | `4fb4608cc4f83f4e9a801123b57a62721699cb9d` |

结论只来自上述源码、tests 及仓库内来源说明，没有发起带凭据的真实 GitHub Copilot 请求。

## 2. Native OpenAI Responses

### 2.1 LiteLLM 总路由条件

LiteLLM 的最终判定不是模型名前缀，而是 provider 是否提供 Responses config：

```text
native = providerResponsesConfig exists
         and use_chat_completions_api is not true
```

否则进入 Responses → Chat Completions bridge。

来源：

- `BerriAI/litellm@ae7e50f:litellm/responses/main.py:394-420`
  (`_bridges_to_chat_completions`, `_will_bridge_to_chat_completions`)
- `BerriAI/litellm@ae7e50f:litellm/responses/main.py:1116-1255`
- `BerriAI/litellm@ae7e50f:tests/test_litellm/responses/test_responses_api_bridge_flag.py:26-83,113-127`

`use_chat_completions_api=true` 强制 bridge；
`openai/chat_completions/<model>` 也会规范化为 OpenAI model 并强制 bridge。

OpenAI 官方 provider 总是提供 Responses config，不检查 `gpt-*` 前缀。
OpenAI-compatible provider 是否 native 取决于 provider 注册方式：

- 声明为 OpenAI provider 且提供自定义 `api_base`：仍直接追加 `/responses`；
- JSON named provider：`supported_endpoints` 必须明确包含 `/v1/responses`；
- 无 Responses config：bridge。

来源：

- `BerriAI/litellm@ae7e50f:litellm/utils.py:8590-8697`
- `BerriAI/litellm@ae7e50f:litellm/llms/openai_like/json_loader.py:12-24,69-79`
- `BerriAI/litellm@ae7e50f:litellm/llms/openai_like/providers.json:126-190`

### 2.2 GitHub Copilot 的 native gate

LiteLLM 对 GitHub Copilot 使用以下 first-match-wins 规则：

1. `mode == "responses"`：native；
2. `mode == "chat"`：bridge，即使同时声明 Responses endpoint；
3. mode 缺失且 raw model metadata 的 `supported_endpoints` 包含 `/v1/responses`：native；
4. model unknown、metadata lookup error 或无明确支持：bridge。

来源：

- `BerriAI/litellm@ae7e50f:litellm/llms/github_copilot/responses/transformation.py:42-75`
- `BerriAI/litellm@ae7e50f:tests/test_litellm/llms/github_copilot/responses/test_github_copilot_responses_transformation.py:390-583`

因此不能使用 `model.startsWith("gpt-")` 或 `vendor == "OpenAI"` 作为充分条件。例如固定 model
metadata 中部分 `gpt-5*` 模型为 `mode=chat`，而 Codex 型号才是 `mode=responses`。

### 2.3 GitHub Copilot native URL 与请求

LiteLLM 的 GitHub Copilot Responses adapter 按以下优先级取得 base：

1. 显式 `api_base`；
2. authenticator 的动态 base；
3. `GITHUB_COPILOT_API_BASE`；
4. `https://api.githubcopilot.com`。

去除末尾 `/` 后追加 `/responses`，默认得到：

```text
https://api.githubcopilot.com/responses
```

来源：

- `BerriAI/litellm@ae7e50f:litellm/llms/github_copilot/responses/transformation.py:243-263`
- `BerriAI/litellm@ae7e50f:litellm/llms/github_copilot/common_utils.py:12-17`

Native 不等于 request bytes 原样透传。LiteLLM 会：

- 只提取 typed Responses 参数；
- 处理 unsupported/drop params；
- 解码 managed `previous_response_id` 和 encrypted item ID；
- 重建 request object；
- 保留 GitHub Copilot reasoning item 的 `encrypted_content`；
- 添加 Copilot identity、`X-Initiator` 和 vision headers。

来源：

- `BerriAI/litellm@ae7e50f:litellm/responses/utils.py:160-286,520-548,620-637`
- `BerriAI/litellm@ae7e50f:litellm/llms/openai/responses/transformation.py:41-276`
- `BerriAI/litellm@ae7e50f:litellm/llms/github_copilot/responses/transformation.py:178-234,265-302`

### 2.4 Native response、stream 与错误

LiteLLM non-stream 会构造 `ResponsesAPIResponse`，并包装 response ID；下一轮请求再解码 managed
ID。Stream 使用 OpenAI Responses SSE decoder，保留 typed events，并统一同一 output index 的
item ID。

来源：

- `BerriAI/litellm@ae7e50f:litellm/responses/main.py:1244-1253`
- `BerriAI/litellm@ae7e50f:litellm/responses/utils.py:309-361,538-548`
- `BerriAI/litellm@ae7e50f:litellm/responses/streaming_iterator.py:246-390,763-838`
- `BerriAI/litellm@ae7e50f:litellm/llms/github_copilot/responses/transformation.py:127-180,278-307`

Native HTTP error 由 provider config 映射。Stream 中的 429、5xx 或未知失败可以进入跨 deployment
fallback，但没有“同一个 provider 的 `/responses` 失败后自动改发 `/chat/completions`”。

来源：

- `BerriAI/litellm@ae7e50f:litellm/llms/custom_httpx/llm_http_handler.py:5926-5986`
- `BerriAI/litellm@ae7e50f:litellm/responses/streaming_iterator.py:150-176,497-525`
- `BerriAI/litellm@ae7e50f:litellm/router.py:4935-4981,6424-6428,7041-7102`

### 2.5 cc-switch 的适用范围

cc-switch 对 Codex/Responses 入站默认选择 native；只有显式配置为 Chat/Anthropic，或 base URL 以
`/chat/completions` 结尾时才 bridge。它不使用 `gpt-*` 或 `supported_endpoints` gate。

来源：

- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/providers/codex.rs:25-85,162-207`

cc-switch 的 native Responses 路径会 parse JSON、执行 model mapping/normalization、删除私有字段并
重新序列化。成功 non-stream body 和 stream chunks 基本透传；response ID 与 usage 不做 LiteLLM
式包装。

来源：

- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/forwarder.rs:1245-1390,1517-1683`
- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/body_filter.rs:21-125`
- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/response_processor.rs:70-209,212-337,682-803`

但固定提交中已证实的托管 GitHub Copilot native Responses 是：

```text
Anthropic Messages input
  -> live CAPI model vendor routing
  -> Responses request
  -> GitHub Copilot /v1/responses
```

没有找到 OpenAI Responses 入站经 Codex adapter 使用托管 Copilot token 的完整 preset/闭环，因此
不能用 cc-switch 证明本项目的 OpenAI Responses → GitHub Copilot native transport。

来源：

- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/providers/copilot_auth.rs:190-216,796-903`
- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/forwarder.rs:2655-2757,3206-3268,4684-4695`
- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/providers/claude.rs:401-453,755-765,921-967`
- `farion1231/cc-switch@3217f72:src-tauri/src/proxy/providers/mod.rs:259-283`

### 2.6 `/responses/compact`

LiteLLM 注册 `/v1/responses/compact`、`/responses/compact` 和
`/openai/v1/responses/compact`。它没有 Chat bridge；provider 无 Responses config 时直接失败，
并在普通 Responses URL 后追加 `/compact`。

来源：

- `BerriAI/litellm@ae7e50f:litellm/proxy/response_api_endpoints/endpoints.py:938-1017`
- `BerriAI/litellm@ae7e50f:litellm/responses/main.py:1959-2079`
- `BerriAI/litellm@ae7e50f:litellm/llms/openai/responses/transformation.py:623-686`

没有源码证据证明 GitHub Copilot CAPI 支持 compact。cc-switch 在 Chat/Anthropic 模式下把 compact
请求改发普通生成 endpoint，这不等同于真实 compaction primitive。

### 2.7 对 ghcp-gateway 的结论

- 应支持 `NativeResponsesPlan | ChatBridgePlan`。
- Native gate 应使用明确 model metadata，不按 `gpt-*` 或 vendor 猜测。
- 推荐采用 LiteLLM 的 Copilot gate：`mode=responses`、`mode=chat`、再检查
  `supported_endpoints`，unknown 时安全回退 bridge。
- Native stream 仍需解析 Responses events，并按 `output_index` 统一到
  `response.output_item.added.item.id`；不能完全 raw passthrough。
- Native 与 bridge 在发请求前确定；同一 provider 的 native HTTP 失败不能自动协议降级。
- `/responses/compact` 暂不注册，直到有 GitHub Copilot capability 和 wire behavior 的独立证据。
- LiteLLM 使用 `/responses`，cc-switch 的另一条 Copilot flow 使用 `/v1/responses`；实现前必须用
  可重复测试或官方行为确认最终 CAPI path。

## 3. Anthropic-compatible model list

### 3.1 Route 与 header 判定

LiteLLM 的 `GET /v1/models` 和 `GET /models` 共用 `model_list`，并先执行 API-key auth。

只要 `anthropic-version` header 存在就返回 Anthropic shape：

```python
request.headers.get("anthropic-version") is not None
```

它不校验 header 值；空值或任意版本字符串同样触发。Header 缺失时返回默认 OpenAI shape。

来源：

- `BerriAI/litellm@ae7e50f:litellm/proxy/proxy_server.py:9871-9939`
- `BerriAI/litellm@ae7e50f:tests/test_litellm/proxy/proxy_server/test_routes_models.py:104-196`

### 3.2 模型来源

Anthropic formatter 接收与默认 OpenAI model list 相同的、已经按当前 credential 权限过滤的完整模型
列表。它不是向 Anthropic 上游查询官方模型目录，也不按 provider/model name 过滤，所以 GPT 等
非 Anthropic 模型也会出现。

来源：

- `BerriAI/litellm@ae7e50f:litellm/proxy/proxy_server.py:9929-10064`
- `BerriAI/litellm@ae7e50f:litellm/proxy/utils.py:7337-7508`
- `BerriAI/litellm@ae7e50f:litellm/proxy/auth/model_checks.py:97-244`
- `BerriAI/litellm@ae7e50f:tests/test_litellm/llms/anthropic/test_anthropic_common_utils.py:2076-2105`

在 ghcp-gateway 中，这对应同一份已经按默认 GitHub Copilot 账号取得并过滤的 CAPI catalog。

### 3.3 Response shape

每个 model：

| Anthropic field | Source |
| --- | --- |
| `type` | 固定 `"model"` |
| `id` | OpenAI-shaped row 的 `id` |
| `display_name` | 同 `id` |
| `created_at` | `DEFAULT_MODEL_CREATED_AT_TIME` 转 UTC ISO-8601 `Z` |
| `max_input_tokens` | row 的 `max_input_tokens` |
| `max_tokens` | row 的 `max_output_tokens` |

`max_input_tokens` 和 `max_tokens` 是 nullable、非 optional；未知时输出 `null`。

Envelope：

```json
{
  "data": [],
  "has_more": false,
  "first_id": null,
  "last_id": null
}
```

非空时 `first_id`、`last_id` 分别取第一项和最后一项 ID。实现不分页，不接受 Anthropic cursor；
始终返回完整权限列表。

来源：

- `BerriAI/litellm@ae7e50f:litellm/llms/anthropic/common_utils.py:1322-1353`
- `BerriAI/litellm@ae7e50f:litellm/constants.py:1639-1641`
- `BerriAI/litellm@ae7e50f:tests/test_litellm/llms/anthropic/test_anthropic_common_utils.py:2076-2160`

Header 只改变成功 serializer。认证、invalid scope 或内部错误不自动转换成 Anthropic error envelope。

### 3.4 `/models` alias

LiteLLM 同时注册 `/v1/models` 与 `/models`。ghcp-gateway 当前文档明确只注册 `/v1/models`。

Anthropic-compatible response 不依赖 `/models` alias；在 `/v1/models` 上进行 header content
negotiation 即可满足 Claude 客户端 discovery。是否增加 alias 是独立兼容性决策。

## 4. 当前文档覆盖度

| Document | Native Responses | Anthropic Models |
| --- | --- | --- |
| `docs/codex_response_to_chat_completions.md` | 只完整定义 Chat bridge；缺少 native planner、transport 和 response | 不适用 |
| `docs/github_copilot_model_listing_apis.md` | 具有 catalog/metadata 基础，但未保留 routing capability | 只有 OpenAI/Ollama serializers；未覆盖 header negotiation |
| `docs/architecture.md` | 明确所有 Responses 都走 Chat，与 native requirement 冲突 | 只描述 OpenAI `/v1/models` |
| Ollama/Anthropic conversion specs | 不适用 | 不覆盖 model list |

因此两个问题当前都没有被生产规范完整覆盖。

## 5. 建议修订

1. 在 Responses 生产规范中增加 transport planner，保留现有 Chat bridge 章节不变。
2. 在内部 model routing metadata 中保留 `mode` 和 `supported_endpoints`；公开 model list 不必暴露。
3. Architecture 将 Responses upstream 改为 native/bridge discriminated plan，并提供两条 stream
   pipeline。
4. Native URL、request normalization、ID strategy 和 error behavior必须在实现前固定；不能只写
   “passthrough”。
5. Model catalog 生产规范增加 `anthropic-version` content negotiation 与完整 Anthropic serializer。
6. 为保持 route 简洁，可继续只注册 `/v1/models`，明确这是相对 LiteLLM 的有意差异。
7. 暂不注册 `/responses/compact`。

## 6. 尚未解决

- LiteLLM Copilot 使用 `{apiBase}/responses`，cc-switch 的另一条 Copilot flow 使用
  `{apiBase}/v1/responses`；本地源码不能证明 CAPI 当前接受哪一个或两者都接受。
- cc-switch 没有证实 OpenAI Responses 入站使用托管 Copilot credential 的完整 native flow。
- LiteLLM 的 compact gate 不证明 GitHub Copilot CAPI 真实支持 compact。
- 未执行带真实 credential 的 CAPI probe。
