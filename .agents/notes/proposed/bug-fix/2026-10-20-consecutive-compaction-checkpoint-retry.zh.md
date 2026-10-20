# Agent Note: 对先前检查点的连续压缩

Status: proposed

[English](2026-10-20-consecutive-compaction-checkpoint-retry.md) | 中文

## 问题

自动压力压缩会在同一步边界运行两次，并显示两条连续的「上下文已压缩」记录。第二次只遮蔽第一次刚写入的检查点。

`dsh-token-meter` 把最近一次匹配的提供方用量复用为 `measure().totalTokens`，再对当前表层节点按固定的每四字符一 token 启发式做有符号增量。保留、范围选择和收缩检查读取的 `nodes[].tokens` 都从该启发式起步。对通过签名回放上一轮 thinking 的 Claude 路由，助手节点的计费回放成本是上一次调用的 `outputTokens`，往往数倍于可见的 `reasoning` 文本。一次真正遮蔽这类节点的压缩之后，计量器只减去启发式价格，因此即使下一次真实 prompt 已低于阈值，`totalTokens` 仍可能高于按路由解析的阈值。

`compactIfNeeded` 随后按 `compactionRetries` 用同一保留预算再试。`selectCompactableRange` 走过同一段近期尾部，因此唯一可压缩区间就是新检查点。再摘要该检查点无法弥合大于其自身价格的缺口。收缩检查失败会写入带错误的 `compaction/end` 且没有检查点，所以 UI 会少计这些浪费的调用。成功的再摘要会改写头部检查点并丢失细节。

在一次已记录的 Opus 5.5 会话中（`reasoningEffort: max`，500,000 token 窗口，128,000 `maxTokens`）：阈值 306,464，保留 59,520；11 次压缩括号；其中 8 次只遮蔽先前检查点（阻塞轮次 195 秒）；三次未通过收缩检查；一次真实的四节点压缩之后计量器读数为 365,183，而下一次 prompt 为 273,367。

这与[可召回压缩](../feature/2026-07-06-recallable-compaction.zh.md)相互独立，后者提议冻结索引存根从而不再改写检查点。它在[回放 token 计量服务 Agent Note](../../archived/architecture/2026-07-15-replay-token-meter-service.md) 的单一 fold 之上扩展，并不替换该 fold，也不改变[按路由的模型上下文与压缩策略](../../implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.zh.md) 中由适配器拥有的容量。

## 提案

按此顺序做两处修改。

### 跳过无法缓解压力的纯检查点区间

在自动 `pressure` 路径上，`selectCompactableRange` 返回区间之后：若每个被选节点都是 `compact-checkpoint` 的 `user/message`，且该区间的路由计价总和至多为 `totalTokens − thresholdTokens`，则不调用摘要器，不写入任何事件。抛出 `Error`，写明纯检查点区间、其价格和剩余超额；现有 `agent/pre-step` 监听器会把它记为警告并继续该轮。价格超过超额的过大检查点仍会再摘要。`/compact` 和 `context-overflow` 保持当前选择。

### 用连续用量校准助手节点价格

当一次成功的 `assistant/message` 在与上一次带用量调用相同的规范请求信封下报告用量时，把 `prompt(当前) − prompt(上次) −（除该助手外新增节点价格）+（被移除节点价格）` 记到上一助手节点，并限制在 `[0, 上次 outputTokens]`。`prompt` 为 `inputTokens + cacheReadTokens + cacheWriteTokens`。信封不同、或该助手节点已不在表层时跳过校准。校准值只存在内存 fold 节点上。`nodes[].tokens` 使用它；`heuristicTokens`、已记录的 `shadowedTokenCount`、`contextBreakdown` 和 UI 标记仍用固定启发式。回放持久日志会重建相同校准。

## 考虑过的替代方案

**只做校准，不跳过纯检查点。** 用量校准能去掉本会话中的误报重试，但其他启发式低估（CJK 文本、JSON schema、信封占主导的工具）仍可能把一次摘要调用花在无法弥合缺口的检查点上。

**永远跳过纯检查点区间。** 这也会丢掉剩余的收敛情形：大于超额的检查点仍可能收缩到阈值以下。价格与超额的比较保留该情形。

**删除 `compactionRetries`。** 这是破坏性配置变更，需要升级指南。跳过使重试在所选区间无法真正缓解压力时成为空操作，因此该旋钮可以保留。

**由适配器或模型声明回放计价。** 提供方是否对回放的 thinking 计费是按模型的 API 事实，代理路由并不总是暴露它。连续用量已经记在日志中，对本会话是精确的。

**把每个助手节点标成 `max(启发式, outputTokens)`。** 丢弃上一轮 reasoning 的路由会过度压缩并丢掉近期历史。

**把已记录的 `shadowedTokenCount` 和 UI 标记改成校准 token。** 那是持久化目录变更。少报的「约 N tokens」标记相对浪费的调用只是展示问题。

**跳过时静默返回 `null`。** 步进前监听器不会记警告，持续压力会从服务器日志中消失。

## 接受标准

- 一次已收缩但仍高于阈值的压缩之后，若下一区间只是新检查点且无法弥合超额，则不再发起第二次摘要调用、不写第二次 `compaction/start`，并留下指明纯检查点区间的警告。
- 若某步边界唯一可压缩节点是已有检查点且无法弥合超额，则不写任何压缩事件。
- 路由价格超过超额的检查点仍会再摘要。
- 同一信封下两次连续带用量调用、且第一助手仍在表层时，将该节点的 `tokens` 设为归因后的回放成本（以 `outputTokens` 为上限），`heuristicTokens` 不变。
- 这两次调用之间发生替换或规范信封变化时，该节点保持启发式价格。
- 包测试覆盖跳过、剩余的收敛重试、归因、信封不匹配、替换和 output-token 上限。带有回放 reasoning 用量的无密钥会话快照在每个达标步边界只记录一对压缩括号。

## 风险

校准把剩余的 prompt 增长记到一个助手节点。同一区间内其他被低估的兄弟节点（CJK 工具结果、未声明视觉计价路由上的图片）可能把该节点抬到 `outputTokens`。上限能阻止价格失控。跨信封变化和替换时跳过校准，避免去解一个欠定区间。跳过并不能缩小本身已高于阈值的保留尾部；只有校准后的节点价格会改变该尾部包含什么。
