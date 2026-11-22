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
    previous: "2026-11-19-cua-input-notices"
    after: "1c3268e7ef74bd59a6bf574494d18bc4041272b12c61582d3970345bc16df93c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "e07afabe760ba54dfc26e6e4efd47e2cb886e0943e5251dd0821f5c932e1f14d"
    decision: same-version
  - root: "event:session/thinking-cap-auto-continue"
    previous: null
    after: "dd91d27c73c092df79ec5a54b350165a702d40a62ec248d7fedead5ffaa27973"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "e598e9d3d4f314ed210bad0aaea57e76d613bd90695c10aa877443ee4b0c17ca"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "6848caacca8b74da207b24d9e4753ebdaf9352cf414177b8121fd0142c472f53"
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
