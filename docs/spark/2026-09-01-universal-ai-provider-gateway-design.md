# WeMediaBuddy 通用 AI Provider 与网关路由设计

状态：Owner 已批准设计，等待书面规格复核  
日期：2026-09-01  
范围：AI Provider 接入、动态凭据、能力探测、按角色模型路由与故障切换  
首个目标网关：Antigravity Manager 与本机 Cockpit 类 OpenAI 网关

## 1. 结论

WeMediaBuddy 不为 Antigravity Manager 建立专用 AI 调用链，也不在应用内复制 Antigravity Manager 的账号管理、配额管理或反代进程管理。

现有“模型预设”原地升级为通用 AI Provider 注册表。Antigravity Manager、Cockpit、OpenCode、官方 API 和本地模型服务都以相同 Provider 合同接入。系统继续复用现有按角色候选链和运行时 fallback，不建立第二套路由系统。

首期能力对标 Hermes 和 Oh My Pi 的外部网关接入方式：

- 外部网关独立运行；
- 客户端保存 Provider 描述，而不是接管上游账号；
- 支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages；
- 支持静态和动态凭据；
- 新任务运行时解析当前凭据；
- 按角色选择首选和备用 Provider/模型；
- 仅在明确的可重试基础设施错误下自动 fallback。

## 2. 调研依据

### 2.1 当前 WeMediaBuddy

现有代码已经提供大部分路由骨架：

- `src/main/pi-config.ts` 保存多个模型预设；
- 每个预设包含 Base URL、协议、模型、思考等级、上下文和输出限制；
- `roleModelPolicies` 为 Planner、Reporter、Writer 等角色保存有序候选链；
- `src/main/pi-config-fallback.ts` 与 Agent runner 负责运行时候选切换；
- 设置页已经包含模型发现、Provider 编辑和角色候选排序；
- 定稿配图通过独立图像 Provider 配置引用已有模型预设。

当前缺口：

1. 只接受 OpenAI Responses 和 Chat Completions；
2. API Key 只能复制后由系统加密保存；
3. 没有统一 Provider 能力与健康状态；
4. 没有本地网关自动发现；
5. 动态密钥轮换后必须手动更新；
6. Provider UI 仍把“预设”和“具体模型”耦合得较紧。

### 2.2 Hermes 与 Oh My Pi

本机现有配置证明两者采用相同的外部网关模式：

- Hermes 将本地网关注册为 custom provider，通过环境变量取得密钥；
- Oh My Pi 将本地网关注册在模型目录中，可通过环境变量或外部命令动态取得密钥；
- 两者都不管理反代网关的账号池，只消费标准协议端点。

### 2.3 Antigravity Manager

Antigravity Manager 官方资料表明：

- 默认统一端口为 `8045`；
- 支持 `/v1/chat/completions`；
- 支持 `/v1/messages`；
- 支持 `/v1/images/generations`；
- AI 请求使用 `Authorization: Bearer <API_KEY>`；
- 本地模式可关闭鉴权，LAN/共享模式可要求鉴权；
- 管理 API 与 AI 协议 API 是不同权限边界。

WeMediaBuddy 首期只消费 AI 协议和无副作用健康接口，不调用账号、配置、启动、停止或日志清理等管理 API。

参考：

- https://github.com/lbjlaq/Antigravity-Manager
- https://github.com/lbjlaq/Antigravity-Manager/blob/main/docs/API_REFERENCE.md
- https://github.com/lbjlaq/Antigravity-Manager/blob/main/docs/proxy/auth.md

## 3. 目标

1. 将现有模型预设升级为可扩展的 Provider 注册表。
2. 支持 Responses、Chat Completions 和 Anthropic Messages 三种文本协议。
3. 支持静态加密密钥、环境变量、JSON 文件字段、外部命令和无需鉴权五种凭据来源。
4. 支持手动配置与本地网关自动发现。
5. 复用现有按角色候选链，提供受控的运行时 fallback。
6. 让现有定稿配图可以选择具有 OpenAI Images 能力的 Provider。
7. 密钥轮换后，新任务无需重新保存 Provider 即可使用新值。
8. 所有安装版行为保持密钥不回显、不落日志、不进入任务快照。

## 4. 非目标

首期不实现：

- 启动、停止或重启 Antigravity Manager；
- 导入或管理 Google、Anthropic、Codex 等上游账号；
- 读取 OAuth Token、Refresh Token 或浏览器 Session；
- 展示或修改 Antigravity Manager 的配额、账号池和路由规则；
- 实现新的全局 fallback 顺序；
- 按请求成本自动选择模型；
- 自动修改 Hermes、OMP、Antigravity Manager 或其他客户端配置；
- 静默保存自动发现结果；
- 在任务执行中热替换已经冻结的连接快照。

## 5. 核心数据模型

现有 Pi 配置升级为下一版本 Provider 状态。迁移必须 clean cutover；运行代码只读取新结构，旧结构在迁移时一次性转换。

### 5.1 ProviderProfile

```ts
type ProviderProtocol =
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic-messages';
type ProviderAuthMode = 'bearer' | 'x-api-key' | 'none';


type ProviderCredentialSource =
  | { kind: 'encrypted'; encryptedValue: string }
  | { kind: 'environment'; variable: string }
  | { kind: 'json-file'; path: string; pointer: string }
  | { kind: 'command'; executable: string; args: string[] }
  | { kind: 'none' };

type ProviderCapabilities = {
  text: boolean;
  vision: boolean;
  imageGeneration: boolean;
  nativeSearch: boolean;
  modelDiscovery: boolean;
};

type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authMode: ProviderAuthMode;
  credentialSource: ProviderCredentialSource;
  capabilities: ProviderCapabilities;
  healthPath?: string;
  models: ProviderModel[];
  lastProbe?: ProviderProbeSummary;
};
```

### 5.2 ProviderModel

模型元数据继续按 Provider 隔离，不建立全局模型 ID 唯一性要求。

```ts
type ProviderModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevels?: RoleThinkingLevel[];
  input: Array<'text' | 'image'>;
};
```

### 5.3 角色候选

现有角色策略结构保留：

```ts
type RoleModelCandidate = {
  profileId: string;
  model: string;
  thinking?: RoleThinkingLevel;
};
```

`profileId` 继续引用 ProviderProfile。候选身份仍由 Provider ID 与模型 ID 共同确定。

## 6. 凭据解析

### 6.1 统一解析接口

所有运行入口只能通过一个 `resolveProviderCredential(profile)` 取得密钥。调用方不得直接读取环境变量、文件、命令或加密字段。

返回：

```ts
type ResolvedCredential = {
  authMode: ProviderAuthMode;
  value?: string;
  sourceKind: ProviderCredentialSource['kind'];
  resolvedAt: string;
};
```
`authMode` 与协议分离：OpenAI 模板默认 `bearer`，官方 Anthropic 模板默认 `x-api-key`，Antigravity Manager 的 Anthropic 兼容接口默认 `bearer`，本地无鉴权服务使用 `none`。调用方只能根据该字段构造允许的鉴权 Header，不能从协议名猜测。
`authMode='none'` 必须配合 `credentialSource.kind='none'`；`bearer` 和 `x-api-key` 必须解析出非空凭据。任何不匹配组合在保存和运行时都 fail-closed。



密钥值只能存在于当前主进程内存和传给 Pi 子进程的临时环境变量中。

### 6.2 加密值

- 沿用 Electron `safeStorage`；
- Renderer 永不取得明文；
- 编辑已有 Provider 时显示“已配置”，不回显值。

### 6.3 环境变量

- 保存变量名，不保存变量值；
- 新 Agent attempt 启动时读取；
- 空值视为配置错误，不回退到其他凭据来源。

### 6.4 JSON 文件字段

- 保存绝对文件路径和 JSON Pointer；
- 只读取普通 JSON 文件；
- 禁止通配符、目录扫描和 JavaScript 表达式；
- 路径不存在、JSON 无效、字段缺失或字段非字符串分别返回明确错误；
- 自动发现只可建议已知文件和字段，必须由用户确认保存。

### 6.5 外部命令

Owner 已批准支持命令解析。该能力视为显式本机代码执行入口，必须 fail-closed。

规则：

- 保存 `executable` 与 `args[]`，不保存一整段隐式 shell 字符串；
- 允许用户显式配置 `powershell.exe -Command ...`；
- 使用 `shell: false`；
- 5 秒硬超时；
- stdout 最大 16 KiB；
- 只接受 trim 后的单个非空值；
- 非零退出、超时、多行输出或空输出均失败；
- stderr 可用于生成去敏错误摘要，但不得包含 stdout 或 Authorization 值；
- 设置页展示完整命令和安全警告；
- 新命令或命令修改必须先通过“测试连接”才能保存；
- 自动发现不得创建命令凭据，除非模板中的命令是项目内置且用户明确确认。

## 7. 连接快照与任务一致性

每个新 Agent attempt 创建不可变 `ResolvedProviderConnection`：

```ts
type ResolvedProviderConnection = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  model: string;
  thinking?: RoleThinkingLevel;
  capabilities: ProviderCapabilities;
  credential: ResolvedCredential;
  resolvedAt: string;
  configRevision: number;
};
```

规则：

- 一次 attempt 内不因设置变更或文件轮换而替换连接；
- 新任务、新 attempt 或切换下一候选时重新解析；
- 401/403 鉴权失败允许对同一候选重新解析一次动态凭据；
- 重新解析后仍失败，才根据错误分类决定是否进入下一候选；
- 任务回执可记录 Provider ID、模型、协议、配置 revision 和 source kind，但不能记录密钥值、命令 stdout 或 Authorization Header。

## 8. 协议适配

### 8.1 OpenAI Responses

继续复用现有 Pi Responses 路径，保留流式输出、工具调用、思考等级和多模态输入。

### 8.2 OpenAI Chat Completions

继续复用现有 Chat Completions 路径。Provider 元数据决定模型是否支持 reasoning、vision 和工具调用。

### 8.3 Anthropic Messages

新增 `anthropic-messages` ProviderProtocol，并映射到 Pi 支持的 Anthropic provider 协议。

必须覆盖：

- system prompt；
- streaming；
- tool use / tool result；
- thinking 配置；
- stop reason；
- 429、401/403 和 5xx 错误分类；
- usage 读回；
- 不把 OpenAI 专属字段发送到 Anthropic 端点。
- 根据 Provider `authMode` 使用 `x-api-key` 或 `Authorization: Bearer`；
- 官方 Anthropic 请求包含明确的 `anthropic-version`，反代模板可覆盖兼容版本；

### 8.4 OpenAI Images

图片生成不是第四种文本协议，而是 Provider capability。

当 `imageGeneration=true` 时，现有定稿配图配置可以引用该 Provider，并调用 `/v1/images/generations`。Provider 的文本协议不限制 Images 能力。

## 9. Provider 探测

### 9.1 手动探测

“测试连接”执行：

1. 解析凭据；
2. 请求显式 healthPath，或已知网关的无副作用健康端点；
3. 请求 `/models`；
4. 规范化模型列表；
5. 保存去敏探测摘要。

没有健康端点时，`/models` 成功即可证明连接和鉴权；不发送收费生成请求作为普通健康检查。

### 9.2 自动发现

首期 discovery adapters：

- Antigravity Manager：默认检查 `127.0.0.1:8045` 和已知本机配置位置；
- Cockpit 类本地访问网关：读取其公开本地访问配置中的 enabled、port 和 API key 字段；
- 通用 localhost：允许用户输入端口后探测，不扫描全部端口。

Discovery 输出候选草稿：

```ts
type DiscoveredProviderDraft = {
  source: 'antigravity-manager' | 'cockpit' | 'manual-local';
  name: string;
  baseUrl: string;
  suggestedProtocol: ProviderProtocol;
  suggestedAuthMode: ProviderAuthMode;
  suggestedCredentialSource: ProviderCredentialSource;
  evidence: string[];
};
```

自动发现不得：

- 导入上游账号；
- 读取 OAuth/Refresh Token；
- 保存未经确认的 Provider；
- 启动或修改本地网关；
- 扫描任意用户目录或所有本机端口。

## 10. 健康状态

Provider 卡片显示：

- `available`：健康或模型探测成功；
- `not-running`：localhost 连接被拒绝；
- `authentication-failed`：401/403；
- `rate-limited`：429；
- `probe-failed`：协议、响应或其他网络错误；
- `not-checked`：尚未探测。

持久化内容仅包括状态、时间、HTTP 状态、去敏错误码和模型数量。错误正文、Header 和命令输出不持久化。

健康状态只帮助用户理解配置，不直接覆盖角色候选顺序。运行时仍以当前真实请求结果为准。

## 11. 运行时 fallback

继续使用每个角色自己的有序候选链。

允许进入下一候选：

- 连接失败；
- DNS/TLS/连接超时；
- 429；
- 可重试 502/503/504；
- 动态凭据重新解析后仍为 401/403；
- Provider 明确返回当前模型不可用。

禁止静默 fallback：

- 用户取消；
- 权限/Authority gate 拒绝；
- 内容验证失败；
- 工具参数错误；
- 业务状态冲突；
- 上下文或任务输入非法；
- Provider 返回确定的非重试 4xx。

每次切换必须记录：角色、前一 Provider/模型、去敏错误码、下一 Provider/模型和 attempt 序号。

## 12. 设置界面

### 12.1 信息架构

现有 AI 设置页保持两个主要区块：

1. AI Provider；
2. 角色分配。

不新增独立“Antigravity 页面”。

### 12.2 Provider 列表

每张卡显示：

- 名称；
- 当前模型；
- 协议；
- 凭据来源类型；
- 能力标签；
- 健康状态和最近检测时间；
- 是否为默认 Provider。

### 12.3 新建 Provider

入口：

- 发现本地网关；
- Antigravity Manager 模板；
- Cockpit 模板；
- OpenAI 兼容模板；
- Anthropic 兼容模板；
- 自定义 Provider。

模板只预填表单。保存后所有 Provider 使用同一数据结构和运行路径。

### 12.4 Provider 编辑器

字段：

- 名称；
- Base URL；
- 文本协议；
- 鉴权方式；
- 凭据来源；
- 模型；
- 思考等级；
- 上下文长度；
- 最大输出；
- 能力开关；
- 可选健康路径。

操作：

- 测试连接；
- 获取模型；
- 保存；
- 删除；
- 设为默认。

命令凭据显示明确的“该命令会在本机执行”警告。

### 12.5 角色分配

沿用当前交互：

- 每个角色独立候选链；
- 首项首选，后续为备用；
- 候选引用 Provider + 模型；
- 候选可以覆盖思考等级；
- Provider 被引用或被非终态任务冻结时禁止删除。

## 13. IPC 与进程边界

Renderer 只能提交凭据描述和测试请求，不得直接执行命令或读取任意文件。

主进程负责：

- 路径验证；
- 环境变量读取；
- JSON 文件读取；
- 命令启动与超时；
- safeStorage；
- Provider 探测；
- 连接快照；
- 去敏错误映射。

Pi 子进程只获得当前 attempt 所需的临时环境变量，不获得凭据来源定义或其他 Provider 的密钥。

## 14. 错误模型

至少包含以下稳定错误码：

- `PROVIDER_CONFIG_INVALID`
- `PROVIDER_PROTOCOL_UNSUPPORTED`
- `PROVIDER_CREDENTIAL_MISSING`
- `PROVIDER_CREDENTIAL_FILE_NOT_FOUND`
- `PROVIDER_CREDENTIAL_JSON_INVALID`
- `PROVIDER_CREDENTIAL_POINTER_MISSING`
- `PROVIDER_CREDENTIAL_COMMAND_TIMEOUT`
- `PROVIDER_CREDENTIAL_COMMAND_FAILED`
- `PROVIDER_CREDENTIAL_OUTPUT_INVALID`
- `PROVIDER_NOT_RUNNING`
- `PROVIDER_AUTHENTICATION_FAILED`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_MODEL_NOT_FOUND`
- `PROVIDER_MODEL_DISCOVERY_FAILED`
- `PROVIDER_REQUEST_RETRYABLE`
- `PROVIDER_REQUEST_REJECTED`

错误对用户显示 Provider 名称和解决动作，不显示凭据内容。

## 15. 迁移

现有配置迁移规则：

- `api` 映射为 `protocol`；
- 旧 OpenAI 协议默认迁移为 `authMode='bearer'`；
- `encryptedApiKey` 映射为 `{ kind: 'encrypted', encryptedValue }`；
- `nativeSearch` 和现有模型元数据进入 capabilities/model；
- `roleModelPolicies` 保持身份和顺序；
- active Provider 保持；
- 迁移完成后只写新版本结构；
- 不保留双轨读取或旧字段写回。

## 16. 验收标准

### 16.1 配置与迁移

1. 旧安装配置升级后 Provider、模型、角色候选顺序和加密密钥均可用。
2. 新安装可以从空配置创建三种文本协议 Provider。
3. 删除被角色或非终态任务引用的 Provider 必须 fail-closed。

### 16.2 凭据

4. 加密值、环境变量、JSON Pointer、外部命令和无鉴权五种来源均可连接。
5. 环境变量、JSON 字段或命令输出轮换后，新任务使用新值。
6. 已开始的 attempt 保持原连接快照。
7. 命令超时、非零退出、空值、多行值和超长值分别失败。
8. 日志、回执、IPC readback、Renderer DOM 和错误信息不包含密钥。

### 16.3 协议

9. Responses streaming、工具调用和 thinking 可用。
10. Chat Completions streaming 和工具调用可用。
11. Anthropic Messages streaming、tool use/tool result 和 thinking 可用，并分别覆盖 `x-api-key` 与 Bearer 兼容网关。
12. 不同协议不会收到其他协议的专属字段。

### 16.4 探测与发现

13. Antigravity Manager 默认端口可被发现并生成待确认草稿。
14. Cockpit 已知本地配置可生成待确认草稿。
15. 自动发现不导入 OAuth Token 或上游账号。
16. `/models` 失败时不清空用户已保存的模型。
17. 探测状态只保存去敏摘要。

### 16.5 路由

18. Planner、Reporter、Writer 等角色继续使用各自候选链。
19. 连接失败、429、可重试 5xx 和动态凭据重解析后仍鉴权失败时进入下一候选。
20. 业务验证、Authority 拒绝、用户取消和非重试 4xx 不得触发 Provider fallback。
21. fallback 记录 Provider/模型和错误码，不记录凭据。

### 16.6 图片生成

22. 具有 Images 能力的 Provider 可被定稿配图选择。
23. Antigravity Manager `/v1/images/generations` 可完成一条真实配图成功路径。
24. 图片能力失败不影响同一 Provider 的文本能力状态。

### 16.7 安装版

25. 安装版真实验证覆盖动态凭据轮换。
26. 安装版真实验证覆盖 401 后重新解析一次。
27. 安装版真实验证覆盖 429 fallback。
28. 安装版真实验证覆盖 Anthropic tool call。
29. 安装版真实验证覆盖 Responses streaming。
30. 安装版真实验证覆盖配图请求。
31. 应用重启后 Provider、角色路由和去敏健康状态可读回。

## 17. 测试策略

最小必要测试：

- Provider 配置迁移；
- 五种凭据解析器的边界与去敏；
- 命令执行超时和输出约束；
- 三种协议的 request/stream/tool 映射；
- `/models` 规范化；
- discovery adapters；
- 401 re-resolve；
- 429/5xx fallback；
- 非重试错误不 fallback；
- Provider 删除引用保护；
- 图片 Provider 引用；
- 设置页新增、测试、发现、保存和角色分配；
- 安装版真实网关场景。

测试不得执行用户真实凭据命令、读取真实账号 Token 或调用收费上游。安装版最终验收可由 Owner 明确授权后使用真实本地网关。

## 18. 安全不变量

1. 自动发现只读取已知的本地代理公开访问配置，不读取上游账号凭据。
2. Renderer 永远拿不到明文密钥。
3. 命令 stdout 永不写日志。
4. Provider 配置和任务回执只保存凭据来源描述。
5. 自动发现必须由用户确认后保存。
6. 不因健康探测自动修改角色候选顺序。
7. 不因 Provider 故障绕过 Authority、业务校验或用户取消。
8. LAN/远程 Base URL 不享受 localhost 自动信任，必须明确配置鉴权。

## 19. 实施边界

该设计是一项可独立实施的 Provider 基础设施升级。实现应按最短关键路径完成：

1. 配置模型与迁移；
2. 凭据解析和去敏错误；
3. Anthropic 协议接入；
4. 探测与自动发现；
5. 设置页；
6. 角色 fallback 接线；
7. 图片 Provider 接线；
8. 安装版验收。

每一步必须迁移真实调用方，不保留旧配置双轨或 Antigravity 专用旁路。
