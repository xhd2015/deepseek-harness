---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-compaction-start-budget

English | [中文](2026-11-18-compaction-start-budget.zh.md)

## Summary

Adds an optional `budget` property to the `compaction/start` event so the pressure budget that admitted an automatic compaction is reconstructable from the session log.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The property is additive and optional: records written before this change remain valid, and a reader that predates it ignores the extra property while still seeing the compaction id, source command, and turn. The budget records the resolved context window, reserved completion tokens, effective headroom, threshold, and retained tokens. It is absent for manual compaction and for triggers that bypass pressure, so absence means no pressure policy decided the call rather than an unknown value.

<a id="verification"></a>
## Verification

`compaction-basic` tests cover the capped headroom across window and output-reserve combinations, the ratio ceiling holding when the configured headroom is larger than the slack it leaves, and the absence of a budget on a manual transaction. One test reads the recorded `compaction/start` payload back from the session log and asserts the five budget fields the automatic trigger resolved.

<a id="dev-note"></a>
## Dev Note

None.
