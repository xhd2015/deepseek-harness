---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-21-message-edit

English | [中文](2026-11-21-message-edit.zh.md)

## Summary

Adds the log-only `message/edit` event, which records an operator correcting or removing the text of one message already present in the Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The event is a new root. The Session store owns its interpretation for every composition, so a log carrying one loads in a build that never wrote it; that is why the fold is core-owned rather than a plugin decision, because an edit written by one build would otherwise make the Session unreadable in another. It arrives as an added session event, which a reader that predates it already skips inside a Session it can load, so no committed generation moves and the change stays a same-version addition.

<a id="verification"></a>
## Verification

`session` covers the fold that applies edits and deletions in log order, the malformed-envelope rejections for a missing seq, an unknown field, a non-boolean `deleted`, and non-string text, and loading a log that contains the event.

<a id="dev-note"></a>
## Dev Note

None.
