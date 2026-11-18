---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-thinking-cap-auto-continue

English | [中文](2026-11-18-thinking-cap-auto-continue.zh.md)

## Summary

Adds the log-only `session/thinking-cap-auto-continue` event, which records whether a Session auto-continues a reasoning-only `max-tokens` stop, and the `thinking-cap-auto-continue` source on `user/message` for the followup that policy produces.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The new event is log-only and marked `ignorable`, so a reader that predates it skips the record and keeps auto-continue off instead of refusing the Session. The new `user/message` source is an added union variant; a reader that predates it keeps the message text and treats the source as unknown. Neither change moves a committed generation, so both are same-version additions.

<a id="verification"></a>
## Verification

`agent-loop` covers the fold (latest flag wins, consecutive-auto-continue counting, an ordinary user message resetting the streak), the reasoning-only `max-tokens` predicate, and the loop itself: two auto-continues then the interrupt banner returns, an inbox with queued work is left alone, and a followup failure still ends the turn. `session` covers writing and reading the `ignorable` envelope, including that a known log-only type still rejects surface metadata.

<a id="dev-note"></a>
## Dev Note

None.
