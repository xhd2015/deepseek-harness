# Agent Note：pi-ai 自定义路由可以提供端点目录

Status: proposed

[English](2026-11-05-pi-ai-endpoint-live-catalog.md) | 中文

## Problem

安装目录未描述的 pi-ai 路由必须在 `cordis.patch.yml` 里列出每一个模型。`discoverModels` 已经会询问 `GET {baseURL}/models`，但回复只是 Models 页面拿来供采纳的候选；什么都不落盘，patch 仍是适配器实际提供的唯一目录。网关增删模型时，即使端点已经在广告该 id，也要改这份列表（或再合并一份生成的 `dsh-models` 片段）。

GUI 选择器读的是 `listModels`。自定义路由在 patch 里没有条目就不能被选。进行中的 pi-ai snapshot 把 settings 文档当作目录，并丢掉任何上游动态刷新，因此网关更换 listing 之后，要等用户再写一次文件，选择器才会更新。

[`llm-deepseek-account`](../../implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.zh.md) 已经按凭据加载 `GET /models`、后台刷新、在内存里保留上一份可用列表，并禁止可配置的 `models` 列表。该模式只用于 DeepSeek 账号路由。

## Proposal

给**自定义** pi-ai 路由一个显式的 live catalog，机制对齐账号路由，不改安装目录路由，也不把 listing 写进 patch。

llm-proxy 的工作独立，文档在 [`external/llm-proxy/docs/live-catalog.md`](../../../../external/llm-proxy/docs/live-catalog.md)。那边仍是嵌套的 `modelListing` 对象（`mode: "dynamic"`）；其 `models` 数组既是启动基准，也是第一次成功 fetch 之后按 `(protocol, provider, providerModelName)` 匹配的 override 列表（含 `excluded`）。本提案消费的是 listing 端点；正确性不依赖 llm-proxy 的改动，但能用上该 inspect API 的扩展字段（`protocol`、`context_window`、`input_modalities`、`reasoning`）。pi-ai 的 `catalog: endpoint` 是另一份文件里的另一套判别，不是 llm-proxy 的 `modelListing`。

### Config

安装目录未描述的路由可以设置 `catalog: endpoint` 并省略 `models`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      llm-proxy-commandcode:
        displayName: Command Code (llm-proxy)
        apiKeyEnv: COMMANDCODE_API_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:8890
        catalog: endpoint
        modelsMaxAgeMs: 3600000
        defaultInput: [text, image]
        modelOverrides:
          deepseek/deepseek-v4-flash:
            reasoningEfforts: { high: high, xhigh: xhigh, max: max }
```

`catalog: endpoint` 同时带 `models` 列表会在解析时被拒绝（与账号路由拒绝 `models` 同样 fail-loud）。安装目录路由不得设置 `catalog: endpoint`；那里省略 `models` 仍表示“提供安装目录”、不打网络。

自定义 live 路由仍然必须有 `api` 和 `baseURL`。一条 pi-ai 路由仍然只说一种协议。同时提供 Anthropic Messages 与 OpenAI Responses 的网关对应两个 DSH provider。根据 listing 里的 `protocol` 在内部拆路由放到后续；v1 保持一条路由一种协议。

`modelsTimeoutMs` / `modelsMaxAgeMs` 与账号路由字段相同。这条路径上 `modelsMaxAgeMs` 默认为 `3600000`（1 小时），不是账号路由的十分钟。`modelOverrides` 按 id 盖在 listing 行上；覆盖了 listing 从未返回的 id 记为 provider 诊断，不隐藏其他模型。

### Runtime

只在 `catalog: endpoint` 路由上，于 `llm-pi-ai` 内复用账号目录机制：

1. 缓存按 listing URL 与凭据指纹分桶。
2. 第一次 `listModels` / `prepareCall` 最多等待 `modelsTimeoutMs`。之后的调用立刻返回缓存，超过 `modelsMaxAgeMs` 则后台刷新。
3. 失败或空列表保留上一份。还没有任何成功结果时，路由不广告模型，请求 fail-loud（`UNKNOWN_MODEL` / 空选择器），不用猜的目录——手写路由没有捆绑的 pi-ai 目录。
4. 刷新成功则构建新的适配器 snapshot。刷新前开始的 `prepareCall` snapshot 留在它所捕获的 generation 上。
5. 发布已有的 provider-topology 通知，让 Web catalog 重建。
6. 不把 listing 写入 settings、`cordis.patch.yml` 或持久缓存。上一份可用列表只在进程内存里，与账号路由相同。

Listing 传输沿用现有 discovery 解析器（`GET {baseURL}/models` 或 Anthropic `GET /v1/models`）。正文带有本适配器已认识的扩展字段（名称、上下文窗口、max tokens、输入模态）时使用它们；缺的字段落到 `defaultContextWindow` / `defaultMaxTokens` / `defaultInput`（默认 `[text]`）以及 reasoning-off。不从 URL 发明图像能力或协议。

未列出的 id 不透传。已保存 session 的模型从 listing 消失后显示为不可用；点名该模型的请求在提供方 I/O 之前失败。

### GUI

`catalog: endpoint` 提供方没有模型列表编辑器，也没有“Fetch available models → Add selected → Save”路径。Models 页面展示只读 listing、上次刷新时间、刷新动作和 override 诊断，姿态与 DeepSeek 账号卡片相同。创建提供方仍需要 id、`api`、`baseURL` 和凭据；不需要模型行。

### `dsh-models`

在本提案落地之前，llm-proxy 的 `dsh-models` 导出仍可能写出完整 `models:` 列表。落地之后，该导出应为 live proxy 路由写出 `catalog: endpoint` 壳（无 `models:`）。导出器改动属于 llm-proxy，不是 DSH 的负载依赖。

## Alternatives considered

**继续把 Fetch-and-save 当作自定义路由唯一的目录。** Discovery 已经存在。网关每次变更仍要人把行采纳进 patch，而这正是本提案要去掉的成本。

**自定义路由省略 `models` 就当作 live，不再设 `catalog` 字段。** 安装目录路由已经用省略表示“已装目录、不打网络”。拼错的 provider id 若静默进入 live，会去探测用户并未打算使用的网关，或像今天一样以 “resolves no models” 失败。判别必须显式。

**把 listing 写回 `cordis.patch.yml`。** 这只是把今天的合并自动化，并让 settings 文档继续当唯一来源，也就是 `reuseCatalogProvider` 目前的假设。它与用户抢写，需要 llm-proxy 编辑器已经为 DSH 片段长出来的 backup/lock，而且不写文件就无法刷新。

**混协议的 llm-proxy 监听器用一个 DSH provider。** pi-ai 每条路由物化一种 `api`。从 listing 的 `protocol` 字段在内部拆分是后续改动；v1 保持一条路由一种协议，这也是 `dsh-models` 现有的分组方式。

**把上一份可用列表持久化到磁盘。** 账号路由拒绝持久缓存，是因为捆绑目录已经覆盖离线启动。自定义路由没有捆绑目录；磁盘缓存会为进程内 listing 增加一种持久格式。冷启动尚无 listing 时用空选择器加 fail-loud，契约更小。

**live 路由透传未列出的 id。** 核心 `LlmRuntime` 允许未列出的 id；pi-ai 自定义路由目前抛 `UNKNOWN_MODEL`。Live catalog 不放宽这一点。看起来像前缀的拼写错误不得变成上游请求。

**把 DeepSeek 账号包推广到每个适配器。** 账号 listing 带 `client_requirements`，并盖在捆绑的 Messages 目录上。网关 listing 没有这些。缓存/刷新对象可以平行实现；门控与捆绑合并留在 `llm-deepseek-account`。

## Acceptance criteria

- 自定义路由设置 `catalog: endpoint`、`api`、`baseURL` 且无 `models` 时能够加载；第一次成功拉取之后 `listModels` 等于 listing 的 id。
- 同一路由若带 `models` 列表，在写入处被拒绝。
- 省略 `models` 的安装目录路由仍从已装目录回答，并且不访问网络。
- 首次拉取慢于 `modelsTimeoutMs` 时，该提供方选择器为空并带诊断；其他提供方仍可选。
- 之后的 listing 增删 id 会更新 `listModels` 和 Web catalog；刷新前开始的 `prepareCall` 保持其 snapshot。
- 刷新失败保留上一份 listing；从未成功过的进程不列出模型，并拒绝点名 id 的请求。
- `modelOverrides` 可改已列出 id 的 window / reasoning / input；未知 override id 记为 directory 诊断。
- live 路由的 Models 页面没有采纳并保存的模型编辑器。
- 已保存 session 的模型若从最新 listing 消失，显示为不可用且不能提交。

## Risks

Live 的 `listModels` 可能在首次拉取时等待，因此今天从内存返回的 Web catalog 构建可能按 live 路由卡住最多 `modelsTimeoutMs`。必须限制等待；按提供方隔离失败，避免一个网关宕掉就清空整个选择器。

网关 listing 往往比精选 patch 大（OpenRouter 式 `/models`，或 Command Code 编译目录 20+ 条对上手选的两条）。没有 include 过滤时，过滤留在**端点**（llm-proxy 的 `include` / 精选静态 patch）。DSH v1 按 listing 原样采用；若产品需要 DSH 侧过滤，作为后续字段。

listing 缺少元数据时，压缩、图像卸载和 reasoning UI 会落到路由默认值。在纯文本网关上误设 `defaultInput: [text, image]` 是配置错误，listing 无法反证。

这不改变 session 格式、请求头或模型可见内容。日志里的 provider 与 model id 仍是路由键，以及用户选中的 listing id（或 override 别名）。
