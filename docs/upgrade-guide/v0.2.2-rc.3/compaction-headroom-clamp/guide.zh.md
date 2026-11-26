---
kind: upgrade-guide
description: "compaction-basic 现在把 headroomTokens 钳制在 thresholdRatio 所留空间之内，因此对输出预留相对上下文窗口较大的路由，自动压缩会更晚开始。"
---

# `compaction-basic` 将 `headroomTokens` 钳制在 `thresholdRatio` 所留空间内

[English](guide.md) | 中文

## 变更

自动压缩原先在 `min(W × thresholdRatio, W − O − headroomTokens)` 处触发，其中 `W` 是路由模型的上下文窗口，`O` 是其请求输出上限。因此当余量大于 `W × thresholdRatio` 之下的空间时，它会完全覆盖 `thresholdRatio`：在预留 `384000` 完成 token 的 `500000` token 窗口上，默认 `65536` token 余量会在 `50464` token 处开始压缩，而不是 `92800`。由于保留策略按 `W − O` 的比例保留近期历史，这种过早触发还会在每次摘要后立即再次触发。

现在 `headroomTokens` 只在比例所留空间内收紧触发点，因此触发点为 `min(W × thresholdRatio, W − O − min(B, W − O − floor((W − O) × thresholdRatio)))`，永不低于比例上限。受影响的配置是 `headroomTokens` 超过该空间的情形，包括为输出预留约五分之一以上容量的窗口上的默认 `65536`。它们的压缩节奏会放缓，每次压缩摘要覆盖更多历史。

## 迁移

1. 无需修改 `cordis.yml`、patch 或 profile；新的钳制自动生效。当 `headroomTokens` 被钳制时，路由到该 provider/model 的首次请求会记录 `compaction-basic: <provider>/<model> headroomTokens <配置值> exceeds the <生效值>-token slack that thresholdRatio <比例> leaves … pressure starts at <阈值> tokens`。
2. 如果某配置把 `headroomTokens` 设到该空间之上，正是为了让压缩比 `thresholdRatio` 更早发生，请改为降低 `thresholdRatio`（例如 `0.6`），因为余量已无法把触发点移到比例上限之下。
3. 可通过读取 Session 日志中下一条 `compaction/start` 事件的 `budget` 属性确认解析后的触发点；它记录该次压缩的 `contextWindow`、`reservedCompletionTokens`、`headroomTokens`、`thresholdTokens` 和 `retainTokens`。手动 `/compact` 不写该属性。
