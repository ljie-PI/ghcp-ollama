# OpenAI Responses 上游路由规范

> 状态：生产行为规范
>
> 固定来源：native capability、GitHub Copilot URL、initiator 和 vision behavior 采用 LiteLLM
> `ae7e50f096a8722bad14d63b6a0d4634d59bf475`；Copilot client identity 采用本项目固定配置；
> Chat bridge 采用
> [Responses → Chat Completions 桥接规范](./codex_response_to_chat_completions.md)

## 1. 范围

本文定义 `POST /v1/responses` 在以下两种执行方式之间的确定性选择：

```text
NativeResponsesPlan
ChatBridgePlan
```

本文负责：

1. 根据已解析的 model routing metadata 选择 plan；
2. 定义 GitHub Copilot native `/responses` 的 URL 与 request ownership；
3. 定义 native non-stream、stream、error 和取消边界；
4. 明确 native 与 Chat bridge 的 history 归属。

本文不重新定义 Responses → Chat 的字段转换，也不定义 `/responses/compact`。

只注册：

```text
POST /v1/responses
```

不注册 `/responses`、`/openai/v1/responses` 或 `/v1/responses/compact` aliases。

## 2. Planning interface

```text
planResponsesExecution(
  request: ResponsesRequest,
  model: ResolvedModel,
  target: BoundCopilotTarget
) -> NativeResponsesPlan | ChatBridgePlan
```

```text
ResolvedModel {
  requestedModel: string
  upstreamModel: string
  routing: ResponsesRoutingMetadata
}

ResponsesRoutingMetadata {
  mode?: JsonValue
  supportedEndpoints?: JsonValue
}

NativeResponsesPlan {
  kind: "native_responses"
  request: ResponsesRequest
  upstreamModel: string
  upstreamUrl: string
  stream: boolean
}

ChatBridgePlan {
  kind: "chat_bridge"
  request: ResponsesRequest
  upstreamModel: string
}
```

Planning 发生在 request converter 之前。Planner 可以读取已绑定账号的 model routing metadata，
但 Responses → Chat converter 仍不得读取 catalog、默认模型或全局配置。

调用 planner 前必须用与实际 upstream request 相同的 model resolver 得到一个
`ResolvedModel`。Capability gate 只读取该 resolved model 的 metadata；alias、默认模型或
deployment mapping 不得在 planning 后再次改变 model。

## 3. Native capability

按以下 first-match-wins 规则判断：

1. `routing.mode === "responses"`：native；
2. `routing.mode === "chat"`：Chat bridge；
3. mode 不是上述两个 string，且 `routing.supportedEndpoints` 是 array，其中至少一个成员是精确
   string `"/v1/responses"`：native；
4. 其他情况：Chat bridge。

Model metadata lookup error、unknown model 或 malformed routing metadata 都安全回退到 Chat bridge。

不得使用以下条件推断 native：

- `model` 以 `gpt-`、`o` 或 `codex` 开头；
- model `vendor` 为 OpenAI；
- CAPI endpoint hostname；
- 请求中存在 Responses-only 字段；
- native 请求曾经成功或失败。

原因是部分 `gpt-*` model 明确使用 `mode:"chat"`，而部分 Codex model 才使用
`mode:"responses"`。

一次请求只 planning 一次；执行过程中 metadata 或默认 model 变化不能改变已选择的 plan。

## 4. Model routing metadata

Model catalog 的公开 DTO 仍只服务 `/v1/models`、Anthropic model list 和 `/api/tags`。
Routing metadata 是独立的内部 snapshot，不在公开 model response 中输出。

来源优先级：

1. pinned model metadata 的 string `mode`；
2. 同一 resolved model raw metadata 的 `supported_endpoints`；
3. unknown。

`mode:"chat"` 是显式 opt-out，优先于 `supported_endpoints`。

不得根据 model ID 维护第二份手写 allowlist。

## 5. Native request

Native plan 不执行：

- history enrichment；
- Responses → Chat request conversion；
- Chat `stream_options.include_usage` 注入；
- Chat ToolContext name flattening；
- Chat reasoning dialect conversion。

执行顺序：

1. 保存已解析的原始 Responses request；
2. 使用 planning 前已得到的同一个 `ResolvedModel`；
3. 将 request 的 `model` 设置为 `ResolvedModel.upstreamModel`；
4. 保留 Responses-native fields，包括 `previous_response_id`、`store`、`include`、`text`、
   `truncation`、reasoning items 和 `encrypted_content`；
5. 使用 Responses request serializer 重新生成 JSON body；
6. 根据 input 判断 vision 与 initiator headers；
7. 发起一次 native request。

这不是原始 bytes 透传：HTTP body 已解析、model 已解析并重新序列化。但除明确的 model 替换和
gateway-private metadata 外，不应用 Chat bridge 的字段丢弃与降级规则。

## 6. Native upstream

GitHub Copilot base URL 由绑定账号的 credential provider 返回。去除末尾 `/` 后追加：

```text
/responses
```

例如：

```text
https://api.githubcopilot.com
  -> https://api.githubcopilot.com/responses
```

该 path 采用固定 LiteLLM GitHub Copilot Responses adapter。cc-switch 的另一条
Anthropic → Copilot flow 使用 `/v1/responses`，不作为本文行为来源。

Native request 使用与 Chat/CAPI 相同的固定 Copilot client identity，并额外支持：

- `openai-intent: conversation-panel`；
- 每请求唯一的 `x-request-id`；
- `x-vscode-user-agent-library-version: electron-fetch`；
- 根据 input 得到的 `x-initiator`；
- 存在 image input 时的 `copilot-vision-request: true`。

Client identity 的 editor/plugin/API versions 使用本项目固定的
`vscode/1.110.1`、`copilot-chat/0.38.2` 和 `2025-10-01`，不采用 LiteLLM 固定提交中的旧版本值。
入站请求不能覆盖 credential 或上述固定 headers。

## 7. Native response

### 7.1 Non-stream

任意 2xx response 必须是一个 Responses JSON object。

Native path：

- 不调用 Chat → Responses converter；
- 不重新生成 response、item 或 call ID；
- 不重新计算 usage；
- 保留上游 Responses body 的字段和顺序语义；
- 删除 hop-by-hop headers；
- 若 transport 解压 body，删除失效的 `content-encoding` 和 `content-length`。

Malformed 2xx JSON 或非 object root 是 invalid upstream response。

### 7.2 Stream

上游 `Content-Type` 为 SSE 时使用 native Responses stream pipeline：

```text
upstream Responses SSE bytes
  -> Responses SSE framing
  -> native event validation
  -> Copilot output-item ID normalization
  -> Responses SSE serialization
  -> downstream bytes
```

Native stream 不经过 Chat SSE decoder，也不经过 Chat → Responses item lifecycle converter。
但不能完全 raw passthrough：GitHub Copilot 可能为同一 `output_index` 的连续 events 返回不同 item
IDs，严格客户端会因此无法关联 reasoning/text parts。

每个 native stream 维护独立的：

```text
Map<output_index, stable_item_id>
```

规则：

1. `response.output_item.added` 具有 integer `output_index`，且 `item.id` 为 string 时，记录该 ID；
2. 同一 `output_index` 的后续 event 若顶层 `item_id` 为 string，改写为已记录的 stable ID；
3. `response.output_item.done` 的 `item` 为 object 时，把 `item.id` 改写为 stable ID；
4. 未见 added、无合法 output index 或无对应字段时不改写；
5. 除上述 ID 归一化外，event fields、usage 和 ordering 不变。

State 只存在于当前 native stream。SSE parser 同时读取 usage、ID 和 error 供日志与监控使用。

Backpressure 和 client abort 必须传播到同一个 upstream request。Client abort 不追加 synthetic
event。

### 7.3 Error

- Non-2xx 保留上游 HTTP status，并使用 Responses-compatible safe error body。
- 上游 secret headers 和完整 body 不进入日志或公开 message。
- Native request 失败后不得对同一个 provider 自动改发 `/chat/completions`。
- 未来的跨账号或跨 deployment retry 必须重新 planning，不能在同一 attempt 中改变 wire mode。
- 已开始 native stream 后不合成 Chat bridge event 或 `response.failed`。

## 8. History ownership

Native plan 使用 GitHub Copilot Responses 自身的 `previous_response_id`、reasoning
`encrypted_content` 和 store semantics；不读写本地 Chat-bridge `ResponsesHistory`。

ChatBridgePlan 继续完整执行：

```text
history enrichment
-> Responses request to Chat
-> Chat response/events to Responses
-> local history record
```

两种 plan 的 response ID namespace 不混用。本地 history lookup 不能猜测或恢复 native upstream
response ID。

## 9. Compact

当前不注册 `/v1/responses/compact`：

- LiteLLM 只按 provider 是否有 Responses config 推断 compact，没有 Copilot-specific compact
  capability；
- cc-switch 在 Chat/Anthropic mode 下把 compact 改发普通生成 endpoint，不证明真实 compaction；
- 当前固定源码不能证明 GitHub Copilot CAPI 支持 `/responses/compact`。

只有独立 production spec 固定 capability、URL、request、response 和 fallback 后才能增加该 route。

## 10. Tests

必须覆盖：

- `mode:"responses"` native；
- `mode:"chat"` 即使 endpoints 包含 Responses 仍 bridge；
- mode missing + `/v1/responses` native；
- unknown/malformed/lookup error bridge；
- `gpt-*`、vendor、hostname 不参与推断；
- planning 后 metadata 变化不改变当前 request；
- native URL 精确为 normalized base + `/responses`；
- native request 保留 Responses-only fields 和 encrypted content；
- native non-stream 不重写 IDs/usage；
- native stream 不经过 Chat decoder/converter，但按 `output_index` 统一 added/sub-event/done item IDs；
- 每个 native stream 的 item-ID map 相互隔离；
- native failure 不进行 same-provider protocol fallback；
- native 不读写 local history；
- bridge path 与原转换规范 fixtures 完全一致；
- `/responses` aliases 和 compact route 为 404。

## 11. 完成标准

1. Routing 与 LiteLLM GitHub Copilot capability gate 等值。
2. Chat bridge 行为仍完全由原桥接规范决定。
3. Native 和 bridge 使用 discriminated plan，不在 stream 中途切换。
4. 不按 model name 或 vendor 猜测 capability。
5. Native Responses-only fields 不经过 Chat round-trip；stream 只执行 Copilot 必需的 item-ID
   归一化。
6. 本地 history 只服务 ChatBridgePlan。
