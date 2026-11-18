---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-compaction-start-budget

[English](2026-11-18-compaction-start-budget.md) | 中文

## 概述

为 `compaction/start` 事件新增可选的 `budget` 属性，使触发自动压缩的压力预算可以从会话日志中还原。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-compaction-start-budget
baseline: false
changes:
  - root: "event:compaction/start"
    previous: "2026-09-11-initial"
    after: "953608c14922d82a34ecc66fbf932d0d91407a663e3f4fa8c3ed3cba1b335cea"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该属性是可选的新增字段：此前写入的记录仍然有效，早于本改动的读取方会忽略该属性，同时仍能读到压缩标识、来源命令和轮次。预算记录解析后的上下文窗口、预留的完成 token、实际生效的余量、阈值和保留 token。手动压缩以及不经过压力判定的触发不写该字段，因此字段缺失表示没有压力策略决定此次调用，而不是取值未知。

<a id="verification"></a>
## 验证

`compaction-basic` 的测试覆盖多种窗口与输出预留组合下的余量钳制、配置余量大于比例所留空间时比例上限仍然生效，以及手动事务不写预算字段。另有测试从会话日志读回 `compaction/start` 负载，断言自动触发解析出的五个预算字段。

<a id="dev-note"></a>
## 开发备注

无。
