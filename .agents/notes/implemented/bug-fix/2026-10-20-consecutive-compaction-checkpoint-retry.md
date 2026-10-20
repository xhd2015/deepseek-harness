# Agent Note: Consecutive compaction of a prior checkpoint

Status: implemented

English | [中文](2026-10-20-consecutive-compaction-checkpoint-retry.zh.md)

## Problem

Automatic pressure compaction can run twice at one step boundary and show two consecutive "Context compacted" rows. The second pass shadows only the checkpoint the first pass just wrote.

`dsh-token-meter` reuses the latest matching provider usage as `measure().totalTokens`, then applies a signed delta from the fixed four-characters-per-token heuristic on current surface nodes. Retention, range selection, and the shrink check read `nodes[].tokens`. For Claude routes that replay prior-turn thinking through a signature, the billed replay cost of an assistant node is the previous call's `outputTokens`, often several times the visible `reasoning` text. After a pass that actually shadows such a node, the meter subtracts only the heuristic price, so `totalTokens` can remain above the routed threshold even when the next real prompt is below it.

`compactIfNeeded` then retries up to `compactionRetries` extra times with the same retain budget. `selectCompactableRange` walks the same recent tail, so the only compactable span is the new checkpoint. Re-summarizing that checkpoint cannot close a gap larger than its own price. Failed shrink checks write `compaction/end` with an error and no checkpoint, so the UI under-counts the wasted calls.

This is independent of [recallable compaction](../../proposed/feature/2026-07-06-recallable-compaction.md). It extends the single-fold measurement in the [replay token meter Agent Note](../../archived/architecture/2026-07-15-replay-token-meter-service.md) without replacing that fold, and it does not change adapter-owned capacity in [routed model context and compaction policy](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md).

## Decision

### Skip a checkpoint-only range that cannot close pressure

On the automatic `pressure` path, after `selectCompactableRange` returns a span: if every selected node is a `compact-checkpoint` `user/message` and the span's route-priced total is at most `totalTokens − thresholdTokens`, compaction does not call the summarizer and writes nothing. It throws an `Error` that names the checkpoint-only span, its price, and the remaining excess; the `agent/pre-step` listener logs that as a warning and continues the turn. An oversized checkpoint whose price exceeds the excess still re-summarizes. `/compact` and `context-overflow` keep current selection.

### Calibrate assistant node prices from consecutive usage

When a successful `assistant/message` reports usage under the same canonical request header as the previous usage-bearing call, the meter attributes `prompt(current) − prompt(previous) − (added node prices except that assistant) + (removed node prices)` to the previous assistant node, clamped to `[0, previous outputTokens]`. `prompt` is `inputTokens + cacheReadTokens + cacheWriteTokens`. Calibration skips when the headers differ or that assistant node is no longer on the surface. The calibrated value lives only on the in-memory fold node. `nodes[].tokens` uses it; `heuristicTokens`, logged `shadowedTokenCount`, `contextBreakdown`, and the UI marker stay on the fixed heuristic. Replay of the durable log reconstructs the same calibration.

## Alternatives considered

**Calibrate only, without the checkpoint-only skip.** Usage calibration removes the false-positive retry on reasoning-heavy Claude sessions, but any other heuristic underpricing (CJK text, JSON schemas, envelope-dominated tools) can still spend a summarizer call on a checkpoint that cannot close the gap.

**Skip checkpoint-only ranges always.** That would also drop the remaining convergence case: a checkpoint larger than the excess can still shrink below threshold. The price-versus-excess check keeps that case.

**Remove `compactionRetries`.** That is a breaking config change and needs an upgrade guide. The skip makes a retry a no-op unless the selected span can actually close pressure, so the knob stays.

**Declare replay pricing per adapter or model.** Whether a provider bills replayed thinking is a per-model API fact, and proxy routes do not always expose it. Consecutive usage is already logged.

**Price every assistant node at `max(heuristic, outputTokens)`.** Routes that drop prior-turn reasoning would over-compact and discard recent history.

**Change logged `shadowedTokenCount` and the UI marker to calibrated tokens.** That is a persistence-catalog change. The understated "~N tokens" marker is cosmetic relative to the wasted calls.

**Return `null` silently when skipping.** The pre-step listener would not log a warning, so persistent pressure would disappear from server logs.

## Consequences

Pressure compaction no longer spends a summarizer call on a prior checkpoint that cannot close the remaining excess. Assistant nodes on routes that replay thinking pick up billed replay cost from the next matching usage sample, so retention and post-pass deltas track the next real prompt more closely. Calibration attributes residual prompt growth to one assistant node and can absorb sibling underpricing up to `outputTokens`. Header changes and replacements skip calibration. A retained tail that is itself above threshold still cannot be reduced without shrinking retention; calibrated prices change what that tail contains.
