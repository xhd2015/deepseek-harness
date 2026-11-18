---
kind: upgrade-guide
description: "compaction-basic now caps headroomTokens at the slack thresholdRatio leaves, so automatic compaction starts later on routes whose output reservation is large relative to the context window."
---

# `compaction-basic` caps `headroomTokens` at the slack `thresholdRatio` leaves

English | [中文](guide.zh.md)

## Change

Automatic compaction used to trigger at `min(W × thresholdRatio, W − O − headroomTokens)`, where `W` is the routed model's context window and `O` its request output cap. A headroom larger than the slack below `W × thresholdRatio` therefore overrode `thresholdRatio` entirely: on a `500000`-token window reserving `384000` completion tokens, the default `65536`-token headroom started compaction at `50464` tokens instead of `92800`. Because retention keeps a fraction of `W − O`, that early trigger also re-triggered immediately after each summary.

`headroomTokens` now only tightens the trigger inside the slack the ratio leaves, so the trigger is `min(W × thresholdRatio, W − O − min(B, W − O − floor((W − O) × thresholdRatio)))` and never falls below the ratio ceiling. Configurations affected are those where `headroomTokens` exceeds that slack, including the default `65536` on windows reserving more than about a fifth of their capacity for output. Their compaction cadence slows; each compaction summary covers more history.

## Migration

1. No `cordis.yml`, patch, or profile change is required; the new cap is automatic. When `headroomTokens` is clipped, the first request routed to that provider/model logs `compaction-basic: <provider>/<model> headroomTokens <configured> exceeds the <effective>-token slack that thresholdRatio <ratio> leaves … pressure starts at <threshold> tokens`.
2. If a configuration set `headroomTokens` above the slack specifically to compact earlier than `thresholdRatio` asked, lower `thresholdRatio` instead (for example `0.6`), since headroom can no longer move the trigger below the ratio ceiling.
3. Confirm the resolved trigger by reading the `budget` property of the next `compaction/start` event in the Session log; it records `contextWindow`, `reservedCompletionTokens`, `headroomTokens`, `thresholdTokens`, and `retainTokens` for that compaction. Manual `/compact` compactions omit it.
