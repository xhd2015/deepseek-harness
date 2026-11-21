---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-21-message-edit

[English](2026-11-21-message-edit.md) | 中文

## 概述

新增只写入日志的 `message/edit` 事件，记录操作者对会话中已存在的某条消息文本的更正或删除。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-21-message-edit
baseline: false
changes:
  - root: "event:message/edit"
    previous: null
    after: "9423ae4dcbf49c305ce7bcadd07dd9d270aac6566e41b9aaca1e2244a0b9e0aa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该事件是一个新的根。会话存储为所有组合拥有它的解释，因此携带该事件的日志在从未写入它的构建中同样可以加载；这正是折叠由内核拥有而非由插件决定的原因，否则某个构建写入的编辑会让该会话在另一个构建中不可读。它以新增会话事件的形式出现，早于它的读取器在可加载的会话中本就会跳过未知类型，因此没有已提交的代次被移动，该变更是同版本新增。

<a id="verification"></a>
## 验证

`session` 覆盖按日志顺序应用编辑与删除的折叠、缺失 seq、未知字段、非布尔 `deleted` 与非字符串文本的畸形信封拒绝，以及加载包含该事件的日志。

<a id="dev-note"></a>
## 开发备注

无。
