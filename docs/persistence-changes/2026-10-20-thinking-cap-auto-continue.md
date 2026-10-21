---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-thinking-cap-auto-continue

English | [中文](2026-10-20-thinking-cap-auto-continue.zh.md)

## Summary

Adds the Session thinking-cap auto-continue policy event and a dedicated user-message source for continue(auto) followups.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The new session/thinking-cap-auto-continue event is log-only and written with ignorable: true, so an older reader skips it and keeps auto-continue off. The thinking-cap-auto-continue message source is an additive MessageSourceMap kind. Consumers already fall through unknown kinds; older readers that validate source as a closed union refuse the continue(auto) user message rather than mis-attribute it. Absence of the policy event means the flag is off.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop/tests/thinking-cap-auto-continue.spec.ts packages/api/session-controller/tests/session-models.host.spec.ts packages/core/session/tests/session.spec.ts packages/session-query/session-log-export/tests/header-action.client.spec.tsx

<a id="dev-note"></a>
## Dev Note

None.
