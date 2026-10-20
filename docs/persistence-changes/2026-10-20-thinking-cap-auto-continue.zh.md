---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-thinking-cap-auto-continue

[English](2026-10-20-thinking-cap-auto-continue.md) | 中文

## 概述

新增 Session 思考上限自动继续策略事件，以及 continue(auto) followup 的专用 user 消息 source。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-thinking-cap-auto-continue
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "9be08a567bc4fcae58c5a95ceb51a59b2cd9fbb27c8dfda73ccb6ad97b198e34"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "cf16cf6d79e0625141cada7d976ba5d99709d3f1d8e96c5ddc940278290989e9"
    decision: same-version
  - root: "event:session/thinking-cap-auto-continue"
    previous: null
    after: "dd91d27c73c092df79ec5a54b350165a702d40a62ec248d7fedead5ffaa27973"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "b2c8d264834d9afd21abbf5fbf749092820d3d4a2840edaf39acdb686f22ee3d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "00d6d939ee82c5abc7ba4420ea19109544e5b1f09129ea26213c955a22f8dd6c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新的 session/thinking-cap-auto-continue 事件仅写入日志，并带 ignorable: true，较旧的读取方会跳过它并把自动继续视为关闭。thinking-cap-auto-continue 消息 source 是 MessageSourceMap 的增量 kind。消费方本来就会跳过未知 kind；把 source 当作封闭联合校验的较旧读取方会拒绝这条 continue(auto) user 消息，而不会误判归属。缺少策略事件表示标志为关闭。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop/tests/thinking-cap-auto-continue.spec.ts packages/api/session-controller/tests/session-models.host.spec.ts packages/core/session/tests/session.spec.ts packages/session-query/session-log-export/tests/header-action.client.spec.tsx

<a id="dev-note"></a>
## 开发备注

无。
