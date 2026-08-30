# GitHub Copilot 模型列表接口实现规范

> 状态：唯一生产行为规范；不保留目标仓库旧实现兼容分支
>
> 固定来源：cc-switch `3217f72596f2d1c0f879f0a05f83803825d9809f`；
> LiteLLM `ae7e50f096a8722bad14d63b6a0d4634d59bf475`；
> Ollama `f96e7aa0513b9973a0ccc71be414c2ecb9d65b1a`

## 1. 行为来源与优先级

本规范采用三个明确的行为来源：

1. GitHub Copilot CAPI 账号、token、动态 endpoint、模型获取和模型缓存采用
   cc-switch 的 GitHub Copilot provider 行为。
2. `GET /v1/models` 的成功 envelope 和 model object 采用 LiteLLM 的
   OpenAI-compatible Models 行为。
3. `GET /api/tags` 的字段结构采用 Ollama 官方协议；CAPI 没有对应值的字段使用
   第 10.2 节明文规定的固定占位值。

发生冲突时，账号、credential、CAPI request、endpoint、transport、解析、过滤和缓存以
cc-switch 为准；OpenAI `/v1/models` response 以 LiteLLM 为准；Ollama `/api/tags`
response 以 Ollama 官方结构和第 10 节映射为准。不存在运行时 profile 选项。

当前仓库已有的模型、认证、HTTP helper、CLI 或错误处理代码不是行为来源。若已有
实现与本文冲突，必须修改或替换已有实现，不得降低本文要求以保持旧行为。

源码文件名和模块名只表示目标仓库中的代码落点，不具有行为规范效力。

## 2. 范围

实现：

```text
GET /v1/models
GET /api/tags
```

两个接口都列出默认 GitHub Copilot 账号在 CAPI `/models` 中可见且允许显示的模型：

- `/v1/models` 输出 OpenAI Models 格式。
- `/api/tags` 输出 Ollama List Models 格式。
- 两个接口使用同一份 Copilot 模型目录。
- 不维护第二份静态模型表。
- 不从模型名称推断账号权限。
- 不执行模型 ID alias、dash/dot 改写或 family fallback。
- 不按名称合并不同 model item。

## 3. 非目标

本实现不负责：

- 改变当前推理模型；
- 修改 Copilot 账号；
- 实现 device-code 登录 UI；
- 返回价格或推测的 token limits；
- 判断请求参数是否被模型支持；
- 代理任意第三方 provider 的 `/v1/models`；
- 实现 Ollama 模型下载、删除、复制或详情接口。

## 4. 公共模型类型

### 4.1 `CopilotCatalogModel`

```text
CopilotCatalogModel {
  id: string
  name: string
  vendor: string
  modelPickerEnabled: boolean
}
```

该类型只包含 CAPI 模型目录中参与两个公开接口转换的字段。

不把 `version`、`preview`、`capabilities` 或 `supported_endpoints` 加入公开目录
类型；这些字段不参与本规范的模型枚举。

### 4.2 `CopilotModelCatalog`

```text
CopilotModelCatalog {
  accountId: string
  models: CopilotCatalogModel[]
  fetchedAt: string
}
```

`fetchedAt` 是成功获得、严格解析、过滤并映射 CAPI 目录后立即读取一次时钟所得的
UTC instant，序列化使用 Go `time.Time` 等价的 RFC3339Nano。实现必须在写入 cache 前读取一次时钟，同一 catalog 的全部
`modified_at` 使用该值。它只用于 `/api/tags` 的 `modified_at` 占位值。

### 4.3 LiteLLM model metadata

```text
getModelInfo(modelId)
  -> {
       mode?: JsonValue
       max_input_tokens?: JsonValue
       max_output_tokens?: JsonValue
     }
     | null
     | throws
```

Lookup null 或异常时不添加 metadata fields。`llm_router` 固定为 null。

`mode` 仅在值为 string 时输出。Token-limit coercion：

- bool、null、object、array → 省略；
- integer → 原值；
- float → Python `int(value)`；转换异常时省略；
- string → Python `int(value)`；转换异常时省略。

## 5. Copilot credential provider

模型目录实现依赖以下抽象接口，不依赖目标仓库当前如何保存 token：

```text
CopilotCredentialProvider {
  resolveDefaultAccountId()
    -> Promise<string | null>

  getValidTokenForAccount(accountId)
    -> Promise<string>

  getApiEndpointForAccount(accountId)
    -> Promise<string>
}
```

### 5.1 默认账号

- 两个公开 endpoint 都调用 `resolveDefaultAccountId()`。
- 没有默认账号时返回认证错误。
- 已保存 default account ID 且该账号仍存在时使用它；否则选择 `authenticated_at` 最大的账号，
  时间相同时选择字典序最小的稳定 account ID；
- 一个 HTTP 请求只能绑定一个 account ID。
- 请求执行期间默认账号变化不得改变该请求已绑定的 account ID。

### 5.2 有效 token

`getValidTokenForAccount(accountId)` 负责：

- github.com 账号使用有效 Copilot session token；
- GHES 账号直接使用已保存的 GitHub OAuth token，不执行 Copilot token exchange；
- Copilot token 缺失，或 `expires_at - now < 60` 秒时，以该账号已有 GitHub credential
  刷新；差值恰好为 60 秒时仍视为有效；
- GHES 账号按 provider 规则使用相应 GitHub credential；
- 同一账号的并发 token 刷新使用互斥锁；
- 获得锁后必须再次检查是否已有其他请求完成刷新；
- 不存在账号、GitHub credential 无效或 token endpoint 明确返回 401 时抛出认证错误；
- token 刷新的 network/connect/TLS 错误、timeout、非 401 HTTP 错误和成功响应解析错误
  必须保留为独立错误类别，不得改写为认证错误。

模型目录模块不得读取固定 token 文件，不得自行启动 device-code flow。

### 5.3 动态 API endpoint

`getApiEndpointForAccount(accountId)` 负责：

1. 按账号查询已缓存 endpoint。
2. 缓存未命中时，使用该账号的 GitHub credential 请求
   `/copilot_internal/user`。
3. 响应存在 `endpoints.api` 时使用该值。
4. 动态查询失败或响应缺少 `endpoints.api` 时，github.com 账号回退到
   `https://api.githubcopilot.com`。
5. 企业账号回退到 `https://copilot-api.{normalizedGitHubDomain}`；保留规范化
   domain 中的显式 port，且不进行额外 DNS 探测。
6. 查询成功时按账号缓存动态 endpoint；成功响应缺少 `endpoints.api` 时缓存对应 fallback。
7. 查询因 network、HTTP 或解析错误而使用 fallback 时不缓存 fallback，下次调用重新查询。
8. 同一账号的并发 endpoint discovery 使用互斥锁并在锁内二次检查。

模型目录模块不得根据推理模型名称选择 endpoint。

`/copilot_internal/user` 必须先完整反序列化：

```text
CopilotUsageResponse {
  copilot_plan: string
  quota_reset_date: string
  quota_snapshots: {
    chat: QuotaDetail
    completions: QuotaDetail
    premium_interactions: QuotaDetail
  }
  endpoints?: {
    api: string
    telemetry?: string
  } | null
}

QuotaDetail {
  entitlement: integer
  remaining: integer
  percent_remaining: number
  unlimited: boolean
}
```

只有整个 DTO 合法才算查询成功。`endpoints` missing/null 时缓存 fallback；`endpoints:{}`、
缺任一其他 required 字段或字段类型错误均是解析失败，使用但不缓存 fallback。

## 6. CAPI Models 请求

### 6.1 URL

```text
modelsUrl = apiEndpoint + "/models"
```

要求：

- 直接在 credential provider 返回的 endpoint 后追加字面量 `/models`。
- 模型目录层不解析、不清理、不补全 endpoint。
- Endpoint 的规范化、scheme、host、port、path、query、fragment 和尾 `/` 均由
  credential provider 负责。
- 构造后的 URL 无法由 HTTP client 接受时按 network/configuration error 处理。

示例：

```text
https://api.githubcopilot.com
  -> https://api.githubcopilot.com/models

https://copilot.example.com/capi
  -> https://copilot.example.com/capi/models
```

### 6.2 Headers

```http
GET {modelsUrl}
Authorization: Bearer <provider token>
Content-Type: application/json
copilot-integration-id: vscode-chat
editor-version: vscode/1.110.1
editor-plugin-version: copilot-chat/0.38.2
user-agent: GitHubCopilotChat/0.38.2
x-github-api-version: 2025-10-01
```

不得接受入站请求覆盖这些 headers。

### 6.3 Transport

- 不发送请求 body。
- Connect timeout 为 30 秒。
- 整个请求 timeout 为 600 秒。
- 调用方取消时必须取消上游请求。
- 不实现模型目录层重试。
- HTTP transport 是否复用连接由共享 client 管理。
- Transport 不自动解压响应；请求不声明压缩编码。
- 重定向行为匹配 cc-switch 所用 reqwest 0.12.28 默认策略：最多跟随 10 次；超过上限、
  `Location` 无效或最终仍为 3xx 时按上游失败处理。Redirect 的 host 或有效 port 改变时删除
  `Authorization`、`Cookie`、`Cookie2`、`Proxy-Authorization` 和 `WWW-Authenticate`；
  仅 scheme 改变但 host/effective-port 不变时按 reqwest 固定行为处理。

### 6.4 HTTP 状态

- 任意 2xx 进入 JSON 解析。
- 非 2xx 视为模型目录获取失败。
- 429 具有单个合法 `Retry-After` 时必须传递给公开 endpoint。
- 非 2xx body 不作为公开错误 message。
- 网络、连接、TLS、timeout 和取消必须与 HTTP 非 2xx 区分。

## 7. CAPI 响应解析

### 7.1 根结构

成功响应必须能严格反序列化为：

```text
CopilotModelsResponse {
  data: CopilotModelsResponseItem[]
}

CopilotModelsResponseItem {
  id: string
  name: string
  vendor: string
  model_picker_enabled: boolean
}
```

规则：

- 根必须是 object。
- `data` 必须存在且为 array。
- 每个 item 必须是 object。
- 四个 item 字段都必须存在且类型正确。
- 未知根字段和未知 item 字段忽略。
- 任一 item 缺字段或类型错误时，整个响应解析失败。
- string 原值保留，不 trim、不截断、不 fallback。
- 不添加默认 `name` 或 `vendor`。

### 7.2 过滤和顺序

解析成功后：

1. 只保留 `model_picker_enabled === true` 的 item。
2. 映射为 `CopilotCatalogModel`。
3. 保持上游原始相对顺序。
4. 不排序。
5. 不去重。
6. 不按 `name` 或 `version` 合并。

合法空 `data` 或过滤后的空列表都是成功结果。

## 8. 模型目录缓存

### 8.1 Cache key

缓存 key 是稳定 account ID：

```text
Map<accountId, CopilotModelCatalog>
Map<accountId, uint64> generation
```

不同账号不得共享目录。

### 8.2 生命周期

- Cache 命中时直接返回该账号目录，不请求 CAPI。
- Cache 没有 TTL。
- 合法空目录也必须缓存。
- 获取失败不得写入 cache。
- 删除账号或退出全部账号时必须删除相应目录。
- 进程退出时 cache 自然销毁。

### 8.3 并发 miss

不增加 single-flight：

- 同一账号的多个并发 miss 可以各自请求 CAPI。
- 每个调用方返回自己成功获取的 catalog。
- Fetch 开始前捕获当前 account generation。
- 成功时 generation 未变化才写入 cache；后完成者覆盖先完成者。
- Generation 已变化时向当前调用方返回该次成功结果，但不写 cache。
- 一个调用方取消只取消自己的上游请求，不影响其他调用方。
- 获取失败不得删除另一个并发调用已经写入的有效 cache。
- `invalidate(accountId)` 删除 entry并递增该账号 generation，不取消在途请求。
- 删除账号执行对应 `invalidate(accountId)`。
- `clear()` 删除全部 entries，并递增所有已知账号 generation。

### 8.4 强制失效

模型目录 service 必须提供：

```text
invalidate(accountId) -> void
clear() -> void
```

公开 `/v1/models` 和 `/api/tags` 不提供绕过 cache 的 query 参数。

## 9. `GET /v1/models`

### 9.1 路由

只注册：

```text
GET /v1/models
```

该 route 使用与 Chat/Responses inference routes 相同的 inbound authentication middleware。

不要求注册 `/models` alias。

查询参数不改变结果。模型目录 endpoint 不接受客户端传入的 GitHub 或 Copilot
credential。

### 9.2 成功响应

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json
{
  "data": [
    {
      "id": "claude-sonnet-4.5",
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai"
    }
  ],
  "object": "list"
}
```

空目录：

```json
{
  "data": [],
  "object": "list"
}
```

### 9.3 字段转换

| OpenAI 字段 | 来源 |
| --- | --- |
| `data[].id` | `CopilotCatalogModel.id` |
| `data[].object` | 固定 `"model"` |
| `data[].created` | `DEFAULT_MODEL_CREATED_AT_TIME` |
| `data[].owned_by` | 固定 `"openai"` |
| `data[].mode` | 第 4.3 节返回的 string，存在时 |
| `data[].max_input_tokens` | 第 4.3 节 coercion 结果，存在时 |
| `data[].max_output_tokens` | 第 4.3 节 coercion 结果，存在时 |
| `object` | 固定 `"list"` |

`DEFAULT_MODEL_CREATED_AT_TIME` 在模块初始化时读取同名环境变量并转十进制 integer；缺失时为
`1677610602`。

不得输出：

- `name`；
- `model_picker_enabled`；
- capabilities；
- price；
- 本地配置或账号字段。

## 10. `GET /api/tags`

### 10.1 成功响应

该 route 使用与 Chat/Responses inference routes 相同的 inbound authentication middleware。

成功响应设置：

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json
{
  "models": [
    {
      "name": "claude-sonnet-4.5",
      "model": "claude-sonnet-4.5",
      "modified_at": "2026-08-30T05:00:00Z",
      "size": 0,
      "digest": "copilot-claude-sonnet-4.5",
      "details": {
        "parent_model": "",
        "format": "Copilot API",
        "family": "GitHub Copilot",
        "families": ["GitHub Copilot"],
        "parameter_size": "unknown",
        "quantization_level": "unknown"
      }
    }
  ]
}
```

空目录：

```json
{
  "models": []
}
```

### 10.2 字段转换

| Ollama 字段 | 来源 |
| --- | --- |
| `models[].name` | `CopilotCatalogModel.id` |
| `models[].model` | `CopilotCatalogModel.id` |
| `models[].modified_at` | `CopilotModelCatalog.fetchedAt` |
| `models[].size` | 固定 `0` |
| `models[].digest` | `"copilot-" + id` |
| `models[].details.parent_model` | 固定 `""` |
| `models[].details.format` | 固定 `"Copilot API"` |
| `models[].details.family` | 固定 `"GitHub Copilot"` |
| `models[].details.families` | 固定 `["GitHub Copilot"]` |
| `models[].details.parameter_size` | 固定 `"unknown"` |
| `models[].details.quantization_level` | 固定 `"unknown"` |

## 11. 公开错误协议

### 11.1 状态分类

| 条件 | HTTP status |
| --- | ---: |
| 无默认账号、账号不存在、credential 无效或 token endpoint 明确返回 401 | 401 |
| Token refresh 的任意 reqwest error（含 network/connect/TLS/timeout） | 502 |
| Token refresh 的其他 HTTP 或解析错误 | 502 |
| CAPI 401 或 403 | 保留上游 status |
| CAPI 429 | 429 |
| CAPI 其他 4xx/5xx | 保留上游 status |
| CAPI 3xx | 502 |
| CAPI 任意 reqwest error（含 network、connect、TLS、timeout） | 502 |
| CAPI 成功 body 无法严格反序列化 | 502 |
| Credential provider 返回的 endpoint 无法构造合法 request URL | 502 |
| 未分类内部错误 | 500 |

取消的 HTTP 请求不得写错误响应。

### 11.2 `/v1/models` 错误

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

字段：

- `message` 使用固定公开文本，不拼接上游 body。
- 401/403 的 `type` 为 `authentication_error`。
- 429 的 `type` 为 `rate_limit_error`。
- 其他错误的 `type` 为 `api_error`。
- `param` 固定为 `null`。
- `code` 是最终 HTTP status 的十进制 string。

### 11.3 `/api/tags` 错误

```json
{
  "error": "Failed to list GitHub Copilot models"
}
```

HTTP status 与第 11.1 节相同。

### 11.4 Error headers

上游 429 具有单个合法 `Retry-After` 时，两个公开 endpoint 都保留该 header。
其他响应不生成 `Retry-After`。

错误响应不得包含 token、完整 endpoint、上游 headers 或 body。

## 12. 取消与资源释放

- 每个公开请求具有独立 caller cancellation signal。
- 等待账号、token 或 endpoint 时发生取消，立即停止该调用方处理。
- 等待 model fetch 时发生取消，取消该调用方自己的上游 HTTP 请求。
- 并发 miss 彼此独立，一个调用方取消不影响其他调用方。
- 连接关闭后不得写响应。
- 所有 signal listener、timer、response body 和 socket 必须释放。

## 13. 目标代码边界

本节只规定代码放置位置，不是行为来源。

### 13.1 `src/utils/copilot_models_client.js`

负责：

- 调用 `CopilotCredentialProvider`；
- 构造 CAPI Models URL 和 headers；
- 发送请求；
- 严格解析 CAPI 响应；
- 过滤 `model_picker_enabled`；
- 按账号缓存目录；
- 管理 account generation；
- 目录失效。

### 13.2 `src/utils/model_response_utils.js`

导出纯函数：

```text
serializeOpenAIModels(catalog, metadataByModelId, defaultModelCreatedAt)
serializeOllamaTags(catalog)
serializeOpenAIModelsError(status)
serializeOllamaTagsError()
```

Service 在调用 serializer 前完成第 4.3 节 lookup，并传入只读
`Map<modelId, normalizedMetadata>`。

序列化器不得读取账号、token、网络、cache 或当前时间。

### 13.3 Credential adapter

认证模块必须提供第 5 节接口。其内部存储格式不属于本文协议，不得暴露给模型目录
模块。

### 13.4 `src/server.js`

负责：

- 注册两个 GET route；
- 对两个 route应用 inference authentication middleware；
- 取得 caller cancellation signal；
- 调用同一个 Copilot model catalog service；
- 选择 OpenAI 或 Ollama serializer；
- 设置成功响应 `Content-Type` 与 `Cache-Control`；
- 设置 HTTP status 和 `Retry-After`；
- 客户端断开后抑制响应。

现有模型列表实现可以被删除或替换；不要求保留旧返回结构或旧调用链。

## 14. 验收要求

### 14.1 Credential 和 endpoint

- 无默认账号返回 401。
- Saved default 不存在时，按 `authenticated_at DESC, accountId ASC` 选择账号。
- GHES 直接返回保存的 GitHub OAuth token。
- 同一请求绑定的账号不随默认账号变化。
- Token 刷新按账号加锁并在锁内二次检查。
- Token 提前刷新阈值精确为 60 秒。
- Stored default 缺失时按最近认证时间和 account ID 稳定 fallback；GHES 直接使用 OAuth token。
- Endpoint discovery 按账号加锁并在锁内二次检查。
- github.com 和企业账号使用第 5.3 节精确定义的动态或 fallback endpoint。
- Endpoint response 必须完整匹配 `CopilotUsageResponse`；只有 `endpoints` missing/null 缓存 fallback。
- `endpoints:{}`、quota 字段缺失/错型和 network/HTTP/parse fallback 均不缓存。
- 模型目录模块不读取认证存储文件。

### 14.2 CAPI request

- URL 由 credential provider 的 endpoint 直接追加 `/models`。
- Headers 与第 6.2 节完全一致。
- 请求无 body。
- Connect timeout 为 30 秒，总 timeout 为 600 秒。
- 取消会终止该调用方自己的上游请求。
- 非 2xx 不自动重试。
- 重定向最多 10 次，host/effective-port 改变时删除第 6.3 节完整敏感 header 集。

### 14.3 CAPI response

- 完整四字段 item 成功解析。
- 缺少任一字段使整个响应失败。
- 任一字段类型错误使整个响应失败。
- 未知字段被忽略。
- `model_picker_enabled:false` 被过滤。
- 上游顺序保持。
- 重复 ID 保持，不去重。
- 合法空目录被缓存。

### 14.4 Cache

- 不同账号缓存隔离。
- 同账号并发 miss 可以各自请求 CAPI，后完成的成功结果覆盖 cache。
- 获取失败不缓存。
- 删除账号或退出全部账号会使目录失效。
- Invalidate/delete/clear 后，旧 generation 的在途成功请求不写 cache。
- Cache 命中不请求 CAPI。
- 公开 query 参数不能绕过 cache。

### 14.5 `/v1/models`

- 使用与 inference routes 相同的 inbound authentication middleware。
- 成功响应固定 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。
- 非空和空目录与第 9 节深度等值。
- 每项至少有 `id`、`object`、`created`、`owned_by`；第 4.3 节有值时追加对应 metadata fields。
- `created` 使用可由环境覆盖的 `DEFAULT_MODEL_CREATED_AT_TIME`。
- `owned_by` 固定为 `"openai"`。
- 错误 envelope、type、param 和 code 与第 11 节一致。

### 14.6 `/api/tags`

- 成功响应 `Content-Type` 为 `application/json; charset=utf-8`。
- 使用与 inference routes 相同的 inbound authentication middleware。
- 成功响应 `Cache-Control` 为 `no-store`。
- 非空和空目录与第 10 节深度等值。
- `name` 和 `model` 相同。
- 同一 catalog 的 `modified_at` 相同。
- `modified_at` 是 RFC3339Nano；整秒不增加 `.000`。
- `details.parent_model` 固定为空 string。
- 不输出禁止字段。
- 错误只包含 `error` string。

### 14.7 安全和取消

- 日志与响应不包含 credential 或完整上游 body。
- 一个已取消调用方不影响其他并发 fetch。
- 连接关闭后不写响应。
- 所有 timer、listener、body 和 socket 被释放。

Golden fixtures 必须固定 clock、`DEFAULT_MODEL_CREATED_AT_TIME` 环境值和 model metadata，并覆盖：

- 完整 endpoint DTO 与每个 malformed branch；
- redirect host/effective-port 变化和五个敏感 header；
- invalidate/remove/clear 与在途成功写回竞态；
- LiteLLM unknown-model四字段 object与 known-model metadata fields；
- RFC3339Nano `modified_at` 与 empty `parent_model`；
- 每个错误 status、合法/非法/重复 `Retry-After` 和取消后零 response bytes。

## 15. 完成标准

实现完成必须同时满足：

1. CAPI 账号、token、endpoint、模型过滤、顺序和缓存符合 cc-switch 固定提交。
2. `/v1/models` envelope 和 model object 符合 LiteLLM 固定提交。
3. `/api/tags` 符合第 10 节 Ollama 映射。
4. 非 Ollama 行为不依赖目标仓库旧模型、认证、HTTP 或 CLI 实现。
5. 目标仓库只提供代码落点和依赖注入，不改变协议行为。
6. 两个公开 endpoint 使用同一个按账号缓存的 Copilot model catalog。
7. 第 14 节全部测试通过。
