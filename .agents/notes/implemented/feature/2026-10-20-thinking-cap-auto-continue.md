# Agent Note: Per-Session auto-continue when thinking hits the output cap

Status: implemented

English | [中文](2026-10-20-thinking-cap-auto-continue.zh.md)

## Problem

Adaptive thinking on routes such as Claude Opus 5.5 counts reasoning toward `max_tokens`. With `reasoningEffort: max`, a step can return `finish.kind === 'max-tokens'` with only reasoning blocks and no visible reply. The loop then ends the turn. The user must type continue, and the interrupt repeats mid-work.

Raising `maxTokens` does not help once the configured cap already fills with thinking. A global default would surprise forked and shared Sessions. A tab-only watcher would lose the effect if the page closed or refreshed between `turn/end` and followup.

## Decision

The Session Header more-actions menu hosts a check, default off, labeled for thinking-cap auto-continue. Toggling it resumes the Session and appends log-only `session/thinking-cap-auto-continue` `{ enabled }` with `ignorable: true`. Last write wins. The host fold `thinkingCapAutoContinue` tracks the policy, whether the latest assistant message is a thinking-cap stop, and the consecutive auto-continue streak; the Client view is the boolean policy. Refresh replays the log.

On `agent/turn-stopping`, the loop followups a user message whose text is exactly `continue(auto)` and whose source is `thinking-cap-auto-continue` when all of these hold:

- the latest policy event is `{ enabled: true }`
- the last assistant message is reasoning-only (no tool calls, no visible text)
- neither inbox list already has work
- fewer than two consecutive prior max-tokens turns were auto-continued

The followup is a new turn. A later `max-tokens` stop with visible text or tool calls still interrupts. Toggling after a banner is already on screen does not resume that turn.

Older readers skip the policy event and treat auto-continue as off. The `continue(auto)` user message remains required model-visible history.

## Alternatives considered

**Client-only `localStorage` plus a tab `followup`.** Refresh in the same browser would restore the check, but a closed tab, another machine, or a fork would not auto-continue. The Session log is the SSOT for Session-local policy.

**Same-turn `steer` from `agent/turn-stopping`.** `max-tokens` is sticky, so the turn would still end as `max-tokens` after a later completed step and still show the interrupt banner.

**Default on.** Shared and forked Sessions would auto-continue 20-minute thinks without an explicit opt-in.

**Unlimited auto-continue.** A reasoning-only cap can loop until the user cancels. Two consecutive auto-continues then restore the banner.

**`kind: 'user'` for the followup.** Typing `continue(auto)` would count toward the cap. The dedicated source keeps the streak exact.

## Consequences

A new first-party Session event and user-message source enter the persistence catalog as a same-version V4 addition. Writers mark the policy event ignorable so an older harness can open the Session. Auto-continue still depends on a live Agent; the check only records policy. The more-actions menu in session-log-export now hosts a Session policy that is not export, because that is the Header ⋯ the product already has.
