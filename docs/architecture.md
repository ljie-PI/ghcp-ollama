# ghcp-gateway 目标架构

## 1. 文档定位

本文定义 ghcp-gateway 重构后的模块、接口、状态归属、路由、依赖方向和运行时技术栈。
它不重复协议字段映射；以下生产规范仍是可观察行为的唯一来源：

- [Ollama Chat → Chat Completions](./ollama_chat_to_chat_completions.md)
- [Anthropic Messages → Chat Completions](./claude_messages_to_chat_completions.md)
- [OpenAI Responses → Chat Completions](./codex_response_to_chat_completions.md)
- [GitHub Copilot 模型列表](./github_copilot_model_listing_apis.md)

`docs/cc-switch/` 和 `docs/litellm/` 是来源说明，不是运行时 profile。架构与生产规范冲突时，
生产规范优先。

## 2. 决策摘要

| 范围 | 决策 |
| --- | --- |
| Runtime | Node.js 24 LTS，ESM |
| 语言 | strict TypeScript |
| HTTP framework | Hono + `@hono/node-server` |
| 上游 HTTP | Undici；CAPI models 使用低层 `request`，其他请求按协议选择 `fetch`/`request` |
| 管理前端 | Svelte 5 + Vite + TypeScript，静态构建 |
| 持久化 | SQLite WAL + `better-sqlite3`，显式 SQL migration |
| 流模型 | `AsyncIterable` + Web `ReadableStream`，pull-based backpressure |
| JSON | 保留 object member 顺序和 number lexeme 的 wire JSON module |
| 日志 | 结构化日志；固定容量的运行时日志和指标快照 |
| 分发 | npm；运行时只有一个 Node.js 进程 |

选择 Hono 的原因是它以 Web Standard `Request`/`Response` 为 interface，TypeScript 支持好，
核心较小，并且不会要求协议 module 依赖 framework-specific context。Hono 只负责路由和
middleware；协议精确字节输出不使用会改变序列化结果的便捷 JSON/SSE helper。

管理前端不使用 SvelteKit server。Vite 构建后的静态文件由同一个 Hono app 提供，因此后台运行时
没有第二个 JavaScript server。

### 2.1 项目身份与命令

- 项目名称：`ghcp-gateway`。
- npm package：`@ljie-pi/ghcp-gateway`。
- npm 只发布一个 executable：`ghcp-gateway`。
- 新实现不保留 `ghcpo`、`ghcpo-server` 或同名 alias。
- 配置、日志、PID/service metadata 和 user data directory 使用 `ghcp-gateway` namespace。

CLI 使用一个 executable 和分组 subcommands：

```tex
ghcp-gateway serve
ghcp-gateway status
ghcp-gateway auth login
ghcp-gateway auth logou
ghcp-gateway auth status
ghcp-gateway models lis
ghcp-gateway models curren
ghcp-gateway models set <model>
ghcp-gateway admin open


`serve` 在前台运行并处理 graceful shutdown。后台常驻由 systemd、launchd、Windows Service 或调用方
process manager 管理，不再维护一个跨平台 PID-file `serverctl` executable。Web 管理页面是配置与
监控的主要交互界面；CLI 只保留启动、诊断、认证和自动化需要的操作。

旧 package、命令和 data path 的一次性迁移策略在实现阶段单独确定，不在运行时长期保留双名称。
README 在代码、CLI 和迁移行为完成后统一更新，避免文档先于可运行行为。

## 3. 设计目标

1. 完整支持四份生产规范，不用公共抽象改写协议特有语义。
2. raw HTTP/SSE、typed Chat chunks、协议状态机和 downstream wire serialization 各自有明确归属。
3. 每个请求的状态独占；跨请求状态只能通过显式 interface 修改。
4. 同一 GitHub Copilot Chat upstream 支撑 OpenAI Chat、Responses、Anthropic 和 Ollama。
5. 协议代码按行为纵向聚合，避免 `controllers/services/repositories` 式横向跳转。
6. 公共 interface 小而深，调用者不需要了解 tool、reasoning、terminal 或 serializer 内部状态。
7. 缓存、history、日志、指标和流队列全部有界。
8. GitHub.com 与 GHES 使用同一个 account model，但凭据、OAuth URL 和 REST URL 按环境正确派生。
9. Web 配置与监控不绕过应用 module，也不读取或返回 secret。

## 4. 非目标

- 不实现运行时 protocol profile、capability switch 或 legacy compatibility branch。
- 不创建会丢失信息的通用 message/canonical model。
- 不提供动态 protocol plugin loader。
- 不支持未被生产规范定义的 `/responses`、`/models` 或 compact aliases。
- 不引入 Redis、PostgreSQL、ORM、消息队列或第二个后台进程。
- 不把 Hono、SQLite driver 或 Undici 包装成没有第二个实现的通用 framework interface。
- 不在 architecture layer 统一各协议的公开错误 DTO。
- 首版不支持多进程或多实例共享可变状态。

## 5. 公开路由

### 5.1 推理与模型路由

| Method | Route | 协议 | 行为 |
| --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions | 原生 Chat 路径；stream 为 OpenAI SSE |
| `POST` | `/v1/responses` | OpenAI Responses | 转换为 Chat；返回 Responses JSON/SSE |
| `POST` | `/v1/messages` | Anthropic Messages | 转换为 Chat；返回 Anthropic JSON/SSE |
| `GET` | `/v1/models` | OpenAI Models | 同一 Copilot model catalog 的 OpenAI 表示 |
| `POST` | `/api/chat` | Ollama Chat | 转换为 Chat；返回 Ollama JSON/NDJSON |
| `GET` | `/api/tags` | Ollama List Models | 同一 Copilot model catalog 的 Ollama 表示 |
| `GET` | `/api/version` | Ollama probe | 只提供兼容版本信息，不参与模型转换 |

路由一致性服从“协议事实标准优先”：

- OpenAI 和 Anthropic-compatible routes 使用 `/v1/...`。
- Ollama 官方协议使用 `/api/...`，不增加 `/v1/ollama/...` 这类非标准 alias。
- 不注册 `/models`、`/responses`、`/openai/v1/responses`、`/claude/v1/messages`、
  `/v1/responses/compact` 或尾斜杠 alias。
- Query string 不参与 route 匹配；是否允许具体 query 由对应生产规范决定。
- `/v1/*`、`/api/chat` 和 `/api/tags` 使用同一个 inference authentication middleware；
  `/api/version`、`/healthz` 和 `/readyz` 不接收 inference credential。

### 5.2 管理与运行状态路由

| Method | Route | 用途 |
| --- | --- | --- |
| `GET` | `/admin/*` | Svelte 静态管理页面 |
| `GET` | `/admin/api/v1/status` | 版本、uptime、认证状态、活动请求和资源概览 |
| `GET/PUT` | `/admin/api/v1/config` | 读取和原子更新可公开配置 |
| `GET/POST` | `/admin/api/v1/accounts` | 账号列表，以及启动 github.com/GHES device flow |
| `DELETE` | `/admin/api/v1/accounts/:accountId` | 删除指定账号及其关联状态 |
| `PUT` | `/admin/api/v1/accounts/default` | 原子切换默认账号 |
| `POST` | `/admin/api/v1/models/refresh` | 显式失效指定账号的 model catalog |
| `GET/DELETE` | `/admin/api/v1/history` | history 使用量和显式清理 |
| `GET` | `/admin/api/v1/events` | 管理页面单向监控 SSE |
| `GET` | `/healthz` | 进程存活 |
| `GET` | `/readyz` | SQLite、配置和必要依赖是否完成初始化 |

管理接口使用独立的 `/admin/api/v1` namespace，不能与兼容协议 route 混用 middleware 或错误
envelope。

## 6. 系统上下文

```mermaid
flowchart LR
    Clients[OpenAI / Anthropic / Ollama clients]
    AdminBrowser[Admin browser]
    Host[Hono HTTP host]
    Protocols[Protocol endpoint modules]
    Catalog[Model catalog module]
    Backend[Copilot backend module]
    GitHub[GitHub.com or GHES]
    CAPI[GitHub Copilot CAPI]
    History[Responses history module]
    State[(SQLite state.db)]
    Admin[Admin module]

    Clients --> Hos
    Host --> Protocols
    Host --> Catalog
    Protocols --> Backend
    Protocols --> History
    Catalog --> Backend
    Backend --> GitHub
    Backend --> CAPI
    History --> State
    AdminBrowser --> Hos
    Host --> Admin
    Admin --> Catalog
    Admin --> History
    Admin --> State


所有推理最终只调用 Chat Completions upstream。这里的 Chat DTO 是上游 wire pivot，不是把所有下游
协议统一成同一种 domain model。

## 7. 总体 module 设计

采用“最小 Gateway interface + 显式协议纵向 modules”：

```mermaid
flowchart TD
    Main[Composition root]
    Gateway[Gateway module]
    Http[Hono host]
    OpenAI[OpenAI Chat module]
    Responses[Responses module]
    Anthropic[Anthropic module]
    Ollama[Ollama module]
    Models[Model catalog module]
    Copilot[Copilot backend module]
    Stream[Chat SSE framing module]
    History[Responses history module]
    Persistence[Persistence module]
    Admin[Admin module]

    Main --> Gateway
    Gateway --> Http
    Http --> OpenAI
    Http --> Responses
    Http --> Anthropic
    Http --> Ollama
    Http --> Models
    Http --> Admin
    OpenAI --> Copilo
    Responses --> Copilo
    Anthropic --> Copilo
    Ollama --> Copilo
    Responses --> History
    Responses --> Models
    Models --> Copilo
    Copilot --> Stream
    History --> Persistence
    Admin --> Persistence


依赖只能沿箭头方向。Protocol modules 不 import Hono、SQLite、`process.env` 或具体 HTTP client。

### 7.1 Gateway module

Gateway 是进程对外的深 module：

```ts
export interface Gateway {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createGateway(
  config: Readonly<GatewayConfig>,
): Promise<Gateway>;


`fetch` 后隐藏：

- 路由和 middleware；
- request scope 与 cancellation；
- account binding；
- 所有协议转换和 stream state；
- GitHub/Copilot transport；
- history 与 catalog cache；
- exact wire serialization；
- 管理 API 和静态资源。

`close()` 幂等。它停止接收新请求、取消在途 upstream、等待有界 grace period，然后关闭 HTTP pool、
SQLite 和日志资源。

### 7.2 Protocol endpoint modules

每个公开推理协议只导出一个 endpoint factory：

```ts
export type ProtocolEndpoint = (
  request: Request,
  scope: Readonly<RequestScope>,
) => Promise<Response>;


```ts
createOpenAiChatEndpoint(dependencies): ProtocolEndpoint;
createResponsesEndpoint(dependencies): ProtocolEndpoint;
createAnthropicMessagesEndpoint(dependencies): ProtocolEndpoint;
createOllamaChatEndpoint(dependencies): ProtocolEndpoint;


这四个 factories 具有相同调用形状，但不继承 `BaseAdapter`，也不要求内部实现同一组
`convertRequest/parseResponse/parseStreamChunk` methods。统一调用形状来自 Fetch interface，
不是人为统一协议语义。

每个 endpoint module 内部隐藏：

1. request decoding 和协议特有 validation；
2. request → Chat conversion；
3. non-stream Chat → protocol response；
4. stream request-local state machine；
5. protocol wire encoder；
6. protocol公开错误映射；
7. exact clock/UUID/token-counter 调用时机。

Hono route 只做显式注册：

```ts
app.post("/v1/responses", (context) =>
  responsesEndpoint(context.req.raw, createRequestScope(context)));


固定 route 数量较少，显式注册比 protocol registry 更易读。增加第五种协议时新增一个纵向 module 和
一条 route，不修改现有协议 implementation。

### 7.3 Request scope

```ts
export interface RequestScope {
  readonly requestId: string;
  readonly principal: InferencePrincipal;
  readonly signal: AbortSignal;
}


Scope 只包含所有请求都真正需要的宿主信息。Protocol-specific context、ToolContext、reasoning
configuration、original request 和 stream cursors 留在对应 protocol module，不能加入
`RequestScope`。

### 7.4 Responses request planning

Responses module 内部必须有一个明确的 request-planning seam；不能让 converter 自行读取 model
catalog、默认模型或全局配置：

```ts
interface ResponsesRequestPlanner {
  prepare(
    request: Readonly<ResponsesRequest>,
    boundCopilot: Readonly<BoundCopilot>,
    catalog: Readonly<CatalogSnapshot>,
    signal: AbortSignal,
  ): Promise<PreparedResponsesRequest>;
}

interface PreparedResponsesRequest {
  readonly chatRequest: ChatRequest;
  readonly responseContext: ResponseContext;
  readonly streamContext: StreamContext;
}


Planner 在 Responses module 内严格执行：

1. 保存客户端显式 `prompt_cache_key`；
2. 调用 Responses history enrichment；
3. 根据已绑定账号的 catalog 选择 model，并同步写入 request 与 request context；
4. 构造 immutable ToolContext；
5. 从 provider/model 配置解析 ReasoningConfig；
6. 调用纯 request converter；
7. 根据已绑定 target 的 host/path 注入 prompt cache key。

Request、response 和 stream contexts 保持协议规范规定的独立类型；不得合并成通用
`ProviderContext` 或 `Capabilities`。

## 8. Copilot backend module

Copilot backend 是协议 modules 使用的唯一 remote seam：

```ts
export interface CopilotBackend {
  bindDefault(signal: AbortSignal): Promise<BoundCopilot>;
}

export interface BoundCopilot {
  readonly accountId: AccountId;
  readonly target: Readonly<CopilotTarget>;

  complete(request: Readonly<ChatRequest>): Promise<ChatResponse>;
  openStream(request: Readonly<ChatRequest>): Promise<UpstreamByteStream>;
}


`bindDefault()` 在一次请求内只执行一次默认账号解析。返回的 `BoundCopilot` 固定 account、credential
和 target；请求执行期间默认账号变化不能影响它。

Production adapter 隐藏：

- GitHub.com/GHES credential 选择；
- Copilot token 刷新；
- CAPI endpoint discovery 和 fallback；
- 固定出站 headers；
- timeout、redirect、取消和连接复用；
- secret redaction；
- `/chat/completions` URL 构造。

Tests 使用 scripted adapter，直接返回 Chat JSON 或可按 byte boundary 控制的 upstream stream。

Model catalog 通过独立、较窄的 source seam 获取 CAPI 数据，不扩大推理 interface：

```ts
interface CopilotModelsSource {
  fetch(
    accountId: AccountId,
    signal: AbortSignal,
  ): Promise<CapiModelsResponse>;
}


Production adapter 复用同一 credential provider 和 HTTP pool；tests 使用 scripted source。

### 8.1 Credential provider internal seam

模型目录规范要求的 credential interface 保留为 Copilot backend 的内部 seam，并补充取消参数：

```ts
interface CopilotCredentialProvider {
  resolveDefaultAccountId(signal: AbortSignal): Promise<AccountId | null>;
  getValidTokenForAccount(
    accountId: AccountId,
    signal: AbortSignal,
  ): Promise<SecretToken>;
  getApiEndpointForAccount(
    accountId: AccountId,
    signal: AbortSignal,
  ): Promise<string>;
}


账号不存在、credential 无效、token endpoint 401、网络错误和 timeout 必须保持不同错误类别。
Protocol modules 不知道 token 的存储方式。

## 9. Streaming 架构

### 9.1 Pipeline

```tex
upstream Uint8Array
  -> incremental UTF-8 decoder
  -> SSE framer
  -> SSE even
  -> Chat SSE decoder
  -> ChatStreamFrame
  -> protocol-local stream state
  -> protocol-local wire encoder
  -> downstream Uint8Array


```ts
export type ChatStreamFrame =
  | { readonly kind: "chunk"; readonly chunk: ChatChunk }
  | { readonly kind: "error"; readonly value: WireJson | string }
  | { readonly kind: "done" };


Async iterator 正常结束与 `kind:"done"` 是不同信号。这样可以同时表达：

- Ollama 对 `[DONE]`、truncation 和唯一 terminal owner 的要求；
- Anthropic 的 `start/consume/finish` lifecycle；
- Responses 的 typed chunk iterator 与 item lifecycle；
- OpenAI Chat 对 raw SSE 的低开销透传。

Raw SSE module 只处理 bytes、UTF-8、BOM、换行、field、multi-data、error frame 和 `[DONE]`。
它不生成 Ollama、Anthropic 或 Responses object。Typed converters 永远不读取 `data:` 或残余
UTF-8 bytes。

### 9.2 Backpressure 与取消

所有 stage 使用 pull-based `AsyncIterable`，一次最多向前读取一个尚未消费的 item。将 iterator
转换成 `ReadableStream` 时，`pull()` 才调用 `iterator.next()`；不创建无界 event queue。

客户端断开时：

1. abort request scope；
2. 取消 upstream fetch；
3. 调用当前 iterator 的 `return()`；
4. 释放 decoder、protocol state 和 timer；
5. 不再输出 error 或 success terminal。

任何 module 都不能通过 callback 在 writer 未消费前继续积压 chunks。

### 9.3 Response commi

Stream writer 显式跟踪 `responseCommitted`：

- 首个 downstream byte 前失败：返回该协议的普通 HTTP error。
- 首个 byte 后失败：由对应 protocol module 决定是否追加协议内错误或直接关闭。
- Client abort：所有协议都直接关闭，不追加任何 bytes。

| 协议 | 已开始输出后的失败 |
| --- | --- |
| Ollama | 非 abort 时恰好追加一个安全 NDJSON error；不再输出 `done:true` |
| Anthropic | 关闭连接；不合成 `event:error` 或 `message_stop` |
| Responses | 关闭连接；不合成 `response.failed` |
| OpenAI Chat | 关闭连接；不合成 `[DONE]` |

### 9.4 Protocol-local terminal ownership

- Ollama reducer 是 `Done` 的唯一消费者和 terminal owner。
- Anthropic converter 维护 start、active block、pending finish/usage 和 exactly-once stop。
- Responses converter 独立维护 response、reasoning、message、tool item、output index 和
  `sequence_number`。
- OpenAI Chat stream 采用 raw fast path；不为透传请求创建其他协议的状态机。

这些状态机不能合并成通用 `StreamTransformer`。

## 10. JSON 与 DTO

### 10.1 Wire JSON

普通 `JSON.parse()` 会重排 integer-like object keys，并把所有 JSON number 转为 JavaScrip
`number`。这不足以满足 ordered arguments、canonical JSON 和 byte golden 要求。

HTTP body reader 因此输出保留 member 顺序和 number lexeme 的语法 AST：

```ts
export type WireJson =
  | null
  | boolean
  | string
  | { readonly kind: "number"; readonly lexeme: string }
  | { readonly kind: "array"; readonly items: readonly WireJson[] }
  | {
      readonly kind: "object";
      readonly members: readonly Readonly<{
        key: string;
        value: WireJson;
      }>[];
    };


Wire JSON module 是 in-process deep module，负责：

- 有界解析；
- source member order；
- missing/null/false/0/empty 的区分；
- compact JSON；
- Unicode code-point canonical key sort；
- ordered object serialization；
- 将通过验证的值转换成 protocol DTO。

它不是 protocol canonical model。Protocol modules 仍直接从自己的 request DTO 转到 Chat DTO。

### 10.2 TypeScript 约束

至少启用：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true,
  "verbatimModuleSyntax": true
}


- Event、frame、error category 和 state phase 使用 discriminated unions。
- `unknown` 只允许出现在 HTTP、SQLite JSON 和 remote response seams。
- 不使用 `as any` 或宽泛 coercion 绕过协议 validation。
- 不用 Zod/TypeBox 的默认 coercion 替代规范中的精确转换规则。
- 只有规范明确要求透传动态字段时使用 `Record<string, unknown>`。

### 10.3 Serializer locality

不同 wire behavior 留在协议 module：

- Ollama：Go-compatible field order、`omitempty`、HTML escaping、RFC3339Nano 和每 object 一个 LF。
- Anthropic：Python default `json.dumps` spacing、`ensure_ascii=true` 和精确 SSE event 文本。
- Responses：Responses event envelope、managed IDs、item ordering 和严格递增 sequence。
- OpenAI Chat：原生 JSON/SSE 和一个成功 `[DONE]`。

不能用一个全局 `serializeResponse(protocol, value)` 条件矩阵实现这些差异。

## 11. 协议 module 职责矩阵

| Module | Request-local state | Shared state | Downstream wire |
| --- | --- | --- | --- |
| OpenAI Chat | stream passthrough 与 request metadata | 无 | JSON / OpenAI SSE |
| Responses | original request、ToolContext、reasoning config、item states、IDs、sequence | Responses history | JSON / Responses SSE |
| Anthropic | original model、active block、tool partial JSON、pending finish/usage、UUID | 无 | JSON / Anthropic SSE |
| Ollama | original model、finish、usage、content/reasoning fragments、sparse tools、clock | 无 | JSON / NDJSON |
| Model catalog | request-bound account、fetch generation | per-account catalog cache | OpenAI Models / Ollama Tags JSON |

协议规范明确引用同一算法时才共享 helper，例如指定的 tool-result media extraction。名称相似但
defaults、ordering、errors 或 bytes 不同的逻辑先保留在协议目录内。

## 12. Responses history

### 12.1 Interface

```ts
export interface ResponsesHistory {
  enrich(
    request: Readonly<ResponsesRequest>,
    signal: AbortSignal,
  ): Promise<ResponsesRequest>;

  record(
    record: Readonly<ResponsesHistoryRecord>,
    signal: AbortSignal,
  ): Promise<void>;
}


Admin 使用单独的 `ResponsesHistoryAdmin` interface 查询统计和清理，避免推理路径获得不需要的
管理能力。

### 12.2 持久化语义

- SQLite 是 source of truth，重启后 history 仍可恢复。
- 整个 store 最多 512 个 responses，按全局插入顺序淘汰。
- TTL 可配置，初始默认 7 天；过期记录在 lookup 时视为不存在。
- `previous_response_id` lookup 优先；call-ID fallback 只在全部未过期记录中唯一命中时使用。
- Response、ordered call items 和 call-ID index 在一个 transaction 中写入。
- 启动、lookup 和 record 时清理过期项；正确性不依赖后台 timer。
- 不增加 read-through memory cache，除非 profiling 证明 SQLite lookup 是瓶颈。

TTL 是此前确认的 gateway 产品要求，但当前 Responses 生产规范只定义 512 条插入淘汰。实施前必须把
TTL、expiry lookup 和测试写入该生产规范；architecture 不能单方面成为协议行为来源。

建议 schema：

```tex
responses(
  response_id,
  insertion_seq,
  created_at,
  expires_at,
  PRIMARY KEY(response_id)
)

response_calls(
  response_id,
  ordinal,
  call_id,
  kind,
  item_json,
  PRIMARY KEY(response_id, ordinal)
)

INDEX response_calls(call_id)
UNIQUE INDEX responses(insertion_seq)
INDEX responses(expires_at)


Non-stream 在完整 Responses response 转换成功后、发送成功 body 前提交。Stream 在 request-local
state 中收集规范要求的 completed items，并在发送 `response.completed` 前提交；提交失败时不发送
成功 terminal。已经发送的中间 events 不回滚，也不合成 `response.failed`。

## 13. Model catalog

Model catalog 是独立 deep module：

```ts
export interface CopilotModelCatalog {
  get(accountId: AccountId, signal: AbortSignal): Promise<CatalogSnapshot>;
  invalidate(accountId: AccountId): void;
  clear(): void;
}


它隐藏：

- 对 credential provider 返回的 endpoint 字面追加 `"/models"`，不在 catalog module 解析、清理或
  规范化 endpoint；
- CAPI `/models` 请求和严格解析；
- account-scoped cache 与 generation；
- 无 TTL、无 single-flight 的固定行为；
- success-empty cache；
- invalidation 后旧在途请求不得写回；
- 30 秒 connect timeout、600 秒 total timeout；
- 使用 Undici 低层 `request`，不声明压缩编码且不自动解压响应；
- 最多 10 次 redirect 及跨 host/effective-port secret header stripping；
- 单个合法 `Retry-After`；
- `/v1/models` 与 `/api/tags` 两个 serializer。

两个公开 routes 始终读取同一 `CatalogSnapshot`，不维护静态模型表，不排序、不去重、不按名称推断
能力。

`CatalogSnapshot.fetchedAt` 在每次成功 fetch 时只读取一次 clock。`DEFAULT_MODEL_CREATED_AT_TIME` 在
module 初始化时读取十进制环境值，缺失时使用 `1677610602`；该值只影响 `/v1/models` 的兼容字段，
不参与 cache key。

## 14. GitHub.com 与 GHES 环境

### 14.1 单一环境解析

用户只配置 GitHub domain。其他 URL 和 OAuth client ID 由 `GitHubEnvironmentResolver` 一次性
派生，避免多个环境变量互相矛盾：

```ts
export type GitHubEnvironment =
  | {
      readonly kind: "github.com";
      readonly host: "github.com";
      readonly webBaseUrl: "https://github.com";
      readonly apiBaseUrl: "https://api.github.com";
      readonly clientId: "Iv1.b507a08c87ecfe98";
    }
  | {
      readonly kind: "ghes";
      readonly host: string;
      readonly webBaseUrl: `https://${string}`;
      readonly apiBaseUrl: `https://${string}/api/v3`;
      readonly clientId: "Ov23li8tweQw6odWQebz";
    };


| 概念 | github.com | GHES |
| --- | --- | --- |
| `GITHUB_HOST` | `github.com` | 用户配置的 `<domain>`，可包含显式 port |
| `GITHUB_API_HOST` | `https://api.github.com` | `https://<domain>/api/v3` |
| `CLIENT_ID` | `Iv1.b507a08c87ecfe98` | `Ov23li8tweQw6odWQebz` |
| `DEVICE_CODE_ENDPOINT` | `https://github.com/login/device/code` | `https://<domain>/login/device/code` |
| `ACCESS_TOKEN_ENDPOINT` | `https://github.com/login/oauth/access_token` | `https://<domain>/login/oauth/access_token` |

`GITHUB_API_HOST` 表示 GitHub REST base URL，不是 Copilot CAPI endpoint。Copilot endpoint 仍按账号
通过 `/copilot_internal/user` discovery；失败时使用生产规范规定的 github.com/GHES fallback。

GHES input 只接受 domain 或 `domain:port`，不接受 path、query、fragment 或 embedded credentials。
OAuth 和 GitHub REST URLs 使用 `URL` 构造，不做字符串拼接。CAPI models URL 是生产规范要求的例外，
必须对已规范化 endpoint 字面追加 `"/models"`。

### 14.2 固定 Copilot client identity

访问 GitHub Copilot/CAPI 时使用以下固定 identity：

| 配置 | 值 |
| --- | --- |
| `editorInfo.name` | `vscode` |
| `editorInfo.version` | `1.110.1` |
| `editorPluginInfo.name` | `copilot-chat` |
| `editorPluginInfo.version` | `0.38.2` |
| `copilotIntegrationId` | `vscode-chat` |

对应 headers：

```http
copilot-integration-id: vscode-cha
editor-version: vscode/1.110.1
editor-plugin-version: copilot-chat/0.38.2
user-agent: GitHubCopilotChat/0.38.2
x-github-api-version: 2025-10-01


这些值集中定义在 Copilot backend module，不从客户端入站 headers 读取，也不允许管理页面单独修改。
需要 vision header 时，由协议 request analysis 产生 typed flag，再由 backend 添加固定
`Copilot-Vision-Request` header。

### 14.3 Token 与 endpoint 生命周期

- github.com 使用有效 Copilot session token；剩余时间 `< 60s` 时按账号刷新，恰好 60 秒仍有效。
- GHES 使用保存的 GitHub OAuth token，不执行 Copilot token exchange。
- 同账号 token refresh 和 endpoint discovery 分别使用 mutex，并在锁内二次检查。
- 不使用全局 30 秒 refresh interval；按需刷新减少后台工作和常驻状态。
- endpoint discovery 的 cache/fallback 规则严格遵守模型目录生产规范。
- 删除账号或全量退出时清除 credential、endpoint 和 model catalog。Responses history 当前为全局
  store，只能通过 retention policy 或显式 history clear 删除。

## 15. Persistence 与配置

### 15.1 SQLite

一个 `state.db` 保存：

- schema migrations；
- 非 secret account metadata；
- 默认账号和模型 preference；
- Web 可修改配置及 revision；
- Responses history。

使用 WAL、foreign keys、busy timeout 和短事务。不使用 ORM。`better-sqlite3` 直接位于 persistence
implementation 内；不创建只有一个 adapter 的 `DatabasePort`。

`node:sqlite` 达到 stable 前不作为 production dependency。若实测同步 SQLite 操作造成可见
event-loop stall，可将同一个 history implementation 移入 worker thread；对 protocol module 的
interface 不变。

OAuth token、Copilot token 和其他 secrets 不存入普通 settings table。Secret storage 使用独立
`CredentialStore` seam，production adapter 采用 OS credential vault；tests 使用 memory adapter。

### 15.2 Runtime config

配置更新流程：

```tex
parse
  -> validate complete candidate
  -> SQLite transaction with revision check
  -> build immutable runtime snapsho
  -> atomic snapshot swap
  -> invalidate only affected caches


失败时继续使用旧 snapshot，不能部分应用。Protocol stream 在开始时捕获 snapshot；请求进行中配置
变化不改变其行为。

## 16. 管理页面

### 16.1 技术栈

- Svelte 5；
- TypeScript；
- Vite；
- 纯静态 SPA；
- 不使用 SvelteKit server；
- 页面较少时不增加 client router，以 tabs/state 切换视图。

构建产物随 npm package 发布，由 Hono 提供 `/admin/*`。浏览器内存不计入 gateway daemon RSS；
关闭页面后后台不保留前端 session。

### 16.2 功能

- GitHub.com/GHES device login；
- 账号列表、默认账号切换和删除；
- 默认模型和安全配置；
- model catalog 查看和显式 refresh；
- Responses history 数量、最旧/最新时间、TTL 和清理；
- 活动请求、活动 streams、请求/错误计数和延迟；
- 最近固定数量的脱敏日志。

实时状态使用 `/admin/api/v1/events` SSE，不使用 WebSocket。事件只携带聚合状态，不携带 prompt、
response body、Authorization、OAuth token、Copilot token 或完整 upstream endpoint。

### 16.3 安全默认值

- 默认只监听 `127.0.0.1`。
- Public inference routes 使用同一个 inference authentication middleware。
- Admin routes 使用独立 admin session 和 CSRF token。
- 一旦允许非 loopback bind，必须配置 admin authentication；TLS 由内置配置或可信 reverse proxy
  提供。
- Static catch-all 只能位于 `/admin/*`，不能吞掉 `/v1/*`、`/api/*`、`/healthz` 或 `/readyz`。

## 17. Error ownership

Runtime 可以使用内部 discriminated union 分类失败：

```ts
type GatewayFailure =
  | { kind: "invalid_request"; cause: unknown }
  | { kind: "unsupported_semantics"; cause: unknown }
  | { kind: "authentication"; cause: unknown }
  | { kind: "upstream_http"; status: number; retryAfter?: string }
  | { kind: "upstream_timeout"; cause: unknown }
  | { kind: "upstream_network"; cause: unknown }
  | { kind: "invalid_upstream_response"; cause: unknown }
  | { kind: "upstream_stream_truncated"; cause: unknown }
  | { kind: "aborted" }
  | { kind: "internal"; cause: unknown };


它不是公开、稳定的 `BridgeError` DTO。每个 protocol endpoint 在自己的 module 内把失败映射为生产
规范要求的 HTTP status、body 或 post-commit 行为。转换异常必须保留 `cause`，不能被 broad catch
改写成成功 response。

Anthropic 和 Responses 转换规范把 pre-commit HTTP status、headers 与 error body 明确交给宿主，
OpenAI Chat 的宿主错误 contract 也不在现有四份规范中。对应 endpoint 必须各自拥有
`AnthropicHttpErrorPresenter`、`ResponsesHttpErrorPresenter` 和 `OpenAiHttpErrorPresenter`，但在
实现前应先补充各 route 的 HTTP error contract。不能用 architecture 文档或一个通用 error envelope
替代缺失的可观察行为规范。

日志只记录分类、request ID、protocol、status 和脱敏 upstream host。不得记录 token、完整 headers、
完整 request/response body 或非 2xx upstream body。

## 18. 资源约束

- JSON body、单个 SSE event、non-stream response 和 protocol accumulator 都有配置上限。
- 超限显式失败，不截断、不返回部分成功。
- 并发 streams 使用有界 semaphore；等待者响应客户端取消。
- Stream pipeline 不预取，不保存 raw chunk 历史。
- Responses 只保留生成 terminal response 与 history record 所需的聚合状态。
- Model catalog cache 按账号有界；账号数量由本地配置约束。
- Responses history 固定全库最多 512 条并有 TTL。
- Metrics label 集合固定，不把 request ID、prompt、任意 model string 作为无界 label。
- 管理日志 ring buffer 和监控订阅者数量有界。
- Token 和 endpoint 采用按需刷新，不使用常驻 polling interval。
- SQLite cleanup 在启动/read/write 时执行，初版不增加只为 cleanup 存在的 timer。

实现进入迁移前需要使用真实 fixtures 建立 RSS benchmark，至少测量：

1. idle；
2. 单 stream；
3. 少量并发 streams；
4. 大量 stream 完成和 abort 后；
5. history 从空到 512 条及 cleanup 后；
6. 管理页面关闭与打开时。

以进程 RSS/Private Bytes/PSS 为主要指标，不能把 V8 `heapUsed`、npm 磁盘大小或浏览器进程内存混为
gateway 常驻内存。

## 19. Testing architecture

### 19.1 Protocol contracts

每个 protocol endpoint 使用同一生产 interface 测试：

```tex
Fetch Reques
  -> endpoin
  -> scripted Copilot backend
  -> Fetch Response bytes


Scripted backend 同时记录转换后的 Chat request，并返回固定 non-stream response 或可控制 byte spli
的 stream，因此 request、response、stream 和 wire behavior 不需要通过 private methods 测试。

必须包含：

- 四份生产规范要求的 differential/golden fixtures；
- Ollama Go-compatible byte golden；
- Anthropic Python JSON/SSE text golden；
- Responses item lifecycle、ToolContext、sequence 和 history round-trip；
- 所有 UTF-8/SSE byte split points；
- abort、timeout、post-commit failure 和零 upstream call；
- missing/null/false/0/empty 与 object member order；
- deterministic clock 和 UUID。

### 19.2 Ports 与 adapters

| Seam | Production adapter | Test adapter |
| --- | --- | --- |
| Copilot backend | Fetch/Undici | Scripted in-process backend |
| Credential store | OS credential vault | Memory store |
| Responses history | SQLite WAL | SQLite temporary database |
| Clock | System clock | Fixed/sequence clock |
| UUID | `crypto.randomUUID()` | Sequence UUID |
| Model metadata | Pinned metadata implementation | Fixed fixture map |

History tests 对 temporary SQLite 运行与 production 相同的 implementation；不另写行为不同的 fake。

### 19.3 Integration

- Hono `app.request()` 覆盖 route、middleware、headers 和 buffered responses。
- Loopback test server 覆盖 streaming、disconnect、redirect、timeout 和 exact bytes。
- Windows、Linux、macOS CI 覆盖 npm package 与 native SQLite dependency。
- Memory tests验证 repeated request/abort 后 active scope 归零且 RSS 达到稳定平台。

## 20. 建议目录

```tex
src/
  main.ts
  gateway/
    create_gateway.ts
    request_scope.ts
    hono_app.ts
    stream_response.ts

  protocols/
    chat_completions/
      types.ts
      sse.ts
    openai_chat/
      endpoint.ts
      wire.ts
    responses/
      endpoint.ts
      bridge.ts
      stream.ts
      tool_context.ts
      wire.ts
    anthropic_messages/
      endpoint.ts
      bridge.ts
      stream.ts
      wire.ts
    ollama_chat/
      endpoint.ts
      bridge.ts
      stream.ts
      wire.ts

  copilot/
    backend.ts
    credentials.ts
    environment.ts
    model_catalog.ts
    transport.ts

  persistence/
    database.ts
    account_store.ts
    responses_history.ts
    migrations/

  serialization/
    wire_json.ts
    canonical_json.ts

  admin/
    api.ts
    auth.ts
    metrics.ts

web/
  src/
  vite.config.ts

tests/
  fixtures/
  contract/
  integration/


目录表示 module locality，不要求每个 type 或函数独立成文件。一个协议的小型 decoder、mapper 和
validator 可以保留在同一文件；只有状态机或 serializer 足够复杂时才拆分。

## 21. Composition roo

`main.ts` 和 `create_gateway.ts` 是唯一 composition root，负责：

1. 读取并验证环境和持久配置；
2. 打开 SQLite 并执行 migration；
3. 创建 credential store、Copilot backend 和 model catalog；
4. 创建 Responses history；
5. 创建四个 protocol endpoints；
6. 显式注册 public/admin routes；
7. 加载静态 Web assets；
8. 注册 graceful shutdown。

Protocol modules 接收 dependencies，不自行读取 `process.env`、打开 database 或创建 HTTP client。

## 22. 取舍与拒绝方案

### 22.1 采用显式协议 modules

固定协议数量少，显式 routes 和 factories 比动态 registry 更易导航。少量 route wiring 重复换来更高
locality；协议新增仍只需新增目录和一条注册语句。

### 22.2 不保留 `BaseAdapter

现有 base class 要求所有协议共享 request、non-stream、raw stream parsing 和 state interface，
但生产规范证明这些 lifecycle 不等价。删除继承层后，raw SSE 与 typed conversion 的 seam 更清楚。

### 22.3 不创建 canonical message model

所有协议都转换到 Chat upstream 不代表它们共享一个可逆 domain model。Responses ToolContext、
Anthropic block、Ollama ordered JSON 和协议特有损失必须留在各自 module。

### 22.4 不统一 stream terminal 与 serializer

终止和 exact bytes 是公开行为。一个带大量 `if (protocol === ...)` 的通用 reducer/serializer 是
shallow module，会降低可读性并扩大修改影响范围。

### 22.5 选择 Hono 而不是更重 framework

当前 routes 少，主要复杂度在协议而不是 controller ecosystem。Hono 提供足够的路由、middleware 和
Web Stream 集成，同时让 protocol modules 保持 Fetch-standard interface。

### 22.6 选择静态 Svelte 而不是 full-stack Web framework

管理页面不需要 SSR、server actions 或独立部署。Svelte + Vite 足以提供 typed、可维护的配置与监控
界面，运行时资源由浏览器承担。

## 23. 实施边界

### 23.1 分支与交付策略

- 远端 `refactor` 是整个重构期间的 integration branch。
- 每项改动从最新 `refactor` 创建独立 work branch，并通过 PR 合并回 `refactor`。
- 不在 `main` 上直接 commit 或 push 重构改动。
- 重构完成、协议 contracts 和 migration 验收通过后，再单独创建 `refactor -> main` 的最终 PR。
- README 更新属于最后阶段的独立改动，与最终代码和命令行为一起进入 `refactor`。

### 23.2 实施顺序

建议按以下顺序实施，但每一步都以对应生产规范 tests 为完成条件：

1. strict TypeScript、Wire JSON 和 composition root；
2. Copilot environment、credential 和 backend；
3. model catalog 与 `/v1/models`、`/api/tags`；
4. raw SSE framing、cancellation 和 backpressure；
5. OpenAI Chat raw path；
6. Ollama endpoint；
7. Anthropic endpoint；
8. Responses endpoint 与 SQLite history；
9. Admin API 和 Svelte UI；
10. 删除旧 JavaScript adapters、callbacks 和重复配置。

迁移期间不长期维护两套生产行为。一个 route 的新 contract tests 完成后整体切换该 route，并删除旧
implementation。
