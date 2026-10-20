# Agent Note: Consecutive compaction of a prior checkpoint

Status: proposed

English | [中文](2026-10-20-consecutive-compaction-checkpoint-retry.zh.md)

## Problem

Automatic pressure compaction can run twice at one step boundary and show two consecutive "Context compacted" rows. The second pass shadows only the checkpoint the first pass just wrote.

`dsh-token-meter` reuses the latest matching provider usage as `measure().totalTokens`, then applies a signed delta from the fixed four-characters-per-token heuristic on current surface nodes. Retention, range selection, and the shrink check read `nodes[].tokens`, which start from that heuristic. For Claude routes that replay prior-turn thinking through a signature, the billed replay cost of an assistant node is the previous call's `outputTokens`, often several times the visible `reasoning` text. After a pass that actually shadows such a node, the meter subtracts only the heuristic price, so `totalTokens` can remain above the routed threshold even when the next real prompt is below it.

`compactIfNeeded` then retries up to `compactionRetries` extra times with the same retain budget. `selectCompactableRange` walks the same recent tail, so the only compactable span is the new checkpoint. Re-summarizing that checkpoint cannot close a gap larger than its own price. Failed shrink checks write `compaction/end` with an error and no checkpoint, so the UI under-counts the wasted calls. Successful re-summaries rewrite the head checkpoint and lose detail.

On one recorded Opus 5.5 session (`reasoningEffort: max`, 500,000-token window, 128,000 `maxTokens`): threshold 306,464, retain 59,520; 11 compaction brackets; 8 of them shadowed only the prior checkpoint (195s of blocked turn time); three failed the shrink check; after a real four-node pass the meter read 365,183 while the next prompt was 273,367.

This is independent of [recallable compaction](../feature/2026-07-06-recallable-compaction.md), which proposes frozen index stubs so a checkpoint is never rewritten. It extends the single-fold measurement in the [replay token meter Agent Note](../../archived/architecture/2026-07-15-replay-token-meter-service.md) without replacing that fold, and it does not change adapter-owned capacity in [routed model context and compaction policy](../../implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md).

## Proposal

Two changes, in this order.

### Skip a checkpoint-only range that cannot close pressure

On the automatic `pressure` path, after `selectCompactableRange` returns a span: if every selected node is a `compact-checkpoint` `user/message` and the span's route-priced total is at most `totalTokens − thresholdTokens`, do not call the summarizer. Write nothing. Throw an `Error` that names the checkpoint-only span, its price, and the remaining excess; the existing `agent/pre-step` listener already logs that as a warning and continues the turn. An oversized checkpoint whose price exceeds the excess still re-summarizes. `/compact` and `context-overflow` keep current selection.

### Calibrate assistant node prices from consecutive usage

When a successful `assistant/message` reports usage under the same canonical request header as the previous usage-bearing call, attribute `prompt(current) − prompt(previous) − (added node prices except that assistant) + (removed node prices)` to the previous assistant node, clamped to `[0, previous outputTokens]`. `prompt` is `inputTokens + cacheReadTokens + cacheWriteTokens`. Skip calibration when the headers differ or that assistant node is no longer on the surface. Store the calibrated value on the in-memory fold node only. `nodes[].tokens` uses it; `heuristicTokens`, logged `shadowedTokenCount`, `contextBreakdown`, and the UI marker stay on the fixed heuristic. Replay of the durable log reconstructs the same calibration.

## Alternatives considered

**Calibrate only, without the checkpoint-only skip.** Usage calibration removes the false-positive retry on this session, but any other heuristic underpricing (CJK text, JSON schemas, envelope-dominated tools) can still spend a summarizer call on a checkpoint that cannot close the gap.

**Skip checkpoint-only ranges always.** That would also drop the remaining convergence case: a checkpoint larger than the excess can still shrink below threshold. The price-versus-excess check keeps that case.

**Remove `compactionRetries`.** That is a breaking config change and needs an upgrade guide. The skip makes a retry a no-op unless the selected span can actually close pressure, so the knob can stay.

**Declare replay pricing per adapter or model.** Whether a provider bills replayed thinking is a per-model API fact, and proxy routes do not always expose it. Consecutive usage is already logged and is exact for this session.

**Price every assistant node at `max(heuristic, outputTokens)`.** Routes that drop prior-turn reasoning would over-compact and discard recent history.

**Change logged `shadowedTokenCount` and the UI marker to calibrated tokens.** That is a persistence-catalog change. The understated "~N tokens" marker is cosmetic relative to the wasted calls.

**Return `null` silently when skipping.** The pre-step listener would not log a warning, so persistent pressure would disappear from server logs.

## Acceptance criteria

- After a shrinking pass that leaves pressure above threshold, a next range that is only the new checkpoint and cannot close the excess produces no second summarizer call, no second `compaction/start`, and a warning that names the checkpoint-only span.
- A step boundary whose only compactable node is an existing checkpoint that cannot close the excess writes no compaction events.
- A checkpoint whose route price exceeds the excess still re-summarizes.
- Two consecutive usage-bearing calls under one header, with the first assistant still on the surface, set that node's `tokens` to the attributed replay cost (capped at its `outputTokens`) and leave `heuristicTokens` unchanged.
- A replacement or canonical header change between those calls leaves the node on the heuristic.
- Package tests cover the skip, the remaining convergence retry, attribution, header mismatch, replacement, and the output-token cap. A keyless session snapshot with replayed-reasoning usage records one compaction pair per qualifying step boundary.

## Risks

Calibration attributes residual prompt growth to one assistant node. Other underpriced siblings in the same interval (CJK tool results, images on routes without declared visual pricing) can inflate that node up to `outputTokens`. The cap prevents runaway prices. Skipping calibration across header changes and replacements avoids solving an underdetermined interval. The skip does not reduce a retained tail that is itself above threshold; only calibrated node prices change what that tail contains.
