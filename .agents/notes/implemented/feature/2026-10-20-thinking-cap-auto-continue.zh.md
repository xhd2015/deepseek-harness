# Agent Note: 思考触及输出上限时按 Session 自动继续

Status: implemented

[English](2026-10-20-thinking-cap-auto-continue.md) | 中文

## Problem

Claude Opus 5.5 这类自适应思考路由把推理计入 `max_tokens`。在 `reasoningEffort: max` 下，一步可以以 `finish.kind === 'max-tokens'` 结束，内容只有 reasoning、没有可见回复。循环随后结束该轮。用户必须手动输入 continue，工作中途会被反复打断。

在已配置的上限已被思考填满时，再提高 `maxTokens` 没有帮助。全局默认会让 fork 与共享 Session 感到意外。只在标签页里监听的话，页面在 `turn/end` 与 followup 之间关闭或刷新就会丢掉效果。

## Decision

Session Header 的更多操作菜单提供勾选项，默认关闭，用于思考上限自动继续。切换时会恢复 Session，并追加仅写入日志的 `session/thinking-cap-auto-continue` `{ enabled }`，且带 `ignorable: true`。最后一次写入生效。Host fold `thinkingCapAutoContinue` 跟踪该策略、最近一条 assistant 消息是否为思考上限停止，以及连续自动继续次数；Client 视图是该布尔策略。刷新会重放日志。

在 `agent/turn-stopping` 时，循环会 followup 一条文本恰好为 `continue(auto)`、source 为 `thinking-cap-auto-continue` 的 user 消息，前提是同时满足：

- 最新策略事件为 `{ enabled: true }`
- 最后一条 assistant 消息仅含思考（无工具调用、无可视文本）
- 两个 inbox 列表都没有待处理工作
- 此前连续自动继续的 max-tokens 轮次少于两次

这次 followup 开启新一轮。之后若 `max-tokens` 停止时带有可见文本或工具调用，仍然会打断。横幅已经出现后再切换，不会恢复那一轮。

较旧的读取方会跳过策略事件，并把自动继续视为关闭。`continue(auto)` user 消息仍是必需的、对模型可见的历史。

## Alternatives considered

**仅用 Client `localStorage` 加上标签页 `followup`。** 同一浏览器刷新可以恢复勾选，但关闭标签页、换机器或 fork 都不会自动继续。Session 日志才是 Session 本地策略的单一事实来源。

**在 `agent/turn-stopping` 里用同一轮 `steer`。** `max-tokens` 会粘滞，因此即便后续步骤正常完成，该轮仍以 `max-tokens` 结束，打断横幅仍会出现。

**默认开启。** 共享和 fork 的 Session 会在用户未明确选择时自动继续长达 20 分钟的思考。

**不限制自动继续次数。** 仅含思考的上限可能一直循环，直到用户取消。连续两次自动继续后恢复横幅。

**followup 使用 `kind: 'user'`。** 用户自己输入 `continue(auto)` 会计入上限次数。专用 source 让连续计数保持精确。

## Consequences

新的一等 Session 事件和 user 消息 source 作为同一版本的 V4 增量进入持久化目录。写入方把策略事件标为可忽略，以便较旧的 harness 仍能打开该 Session。自动继续仍依赖存活的 Agent；勾选只记录策略。session-log-export 的更多操作菜单现在承载一项与导出无关的 Session 策略，因为产品里已经有这个 Header ⋯ 入口。
