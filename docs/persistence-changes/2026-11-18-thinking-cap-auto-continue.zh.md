---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-thinking-cap-auto-continue

[English](2026-11-18-thinking-cap-auto-continue.md) | 中文

## 概述

新增仅记录到日志的 `session/thinking-cap-auto-continue` 事件，用于记录该会话是否在推理内容撞上 `max_tokens` 时自动续写；同时为 `user/message` 新增 `thinking-cap-auto-continue` source，标识该策略产生的续写消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-thinking-cap-auto-continue
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8b2803fdcce1c5ab6280690030edcef89a19487259e5ea78eef1331938bfdb6c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "d273e5479fa562015a653c16ad98d64ec8e67e452f271062d386340911a3973b"
    decision: same-version
  - root: "event:session/thinking-cap-auto-continue"
    previous: null
    after: "dd91d27c73c092df79ec5a54b350165a702d40a62ec248d7fedead5ffaa27973"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f7699a6af053ba0304c36c0c4bb4489bb2e97ac81d7d10216dc5fe92b8baa00c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "1b0bf99d7aa93189641496a161b94c173474c1145c77daa7132d666f46d8ea8c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新事件仅写入日志并标记为 `ignorable`，因此早于本改动的读取方会跳过该记录并保持自动续写关闭，而不是拒绝整个会话。新的 `user/message` source 是新增的联合类型变体；早于本改动的读取方保留消息文本，并将该 source 视为未知。两者都没有移动已提交的代际，因此属于同版本的新增。

<a id="verification"></a>
## 验证

`agent-loop` 覆盖折叠加（最新标志生效、连续自动续写计数、普通用户消息重置计数）、仅推理的 `max_tokens` 判定，以及循环本身：连续两次自动续写后中断横幅恢复、队列中已有工作时不再续写、续写失败仍能正常结束轮次。`session` 覆盖 `ignorable` 信封的写入与读取，并验证已知的仅日志类型即使标记为忽略仍拒绝 surface 元数据。

<a id="dev-note"></a>
## 开发备注

无。
