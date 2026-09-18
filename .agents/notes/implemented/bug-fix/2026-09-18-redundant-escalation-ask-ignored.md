# Agent Note: A redundant escalation ask is ignored, not refused

Status: implemented

English | [中文](2026-09-18-redundant-escalation-ask-ignored.zh.md)

## Problem

A model that emits **every declared property** of a tool schema turns an optional escalation field into a de facto required one, and two sessions on a local `codex` route (`gpt-5.6-terra`) show what that costs.

The first session attached `sandbox_permissions: "danger-full-access"` with `justification: ""` to its first bash command. The pairing was validated before the widening check, so the refusal named the empty sentence; the model read that as "write a better sentence", prepared a caption reading `Clarifying justification requirements`, and retried with a filled-in justification — which the strictly-wider check then rejected, because the call already ran at `danger-full-access`. The turn cost four bash calls, two decoy refusals, and a user abort.

Making those refusals single and instructional — judging the impossible ask before its pairing, and naming the remedy — was not enough. The second session sent all seven bash properties on **every** call (`command`, `description`, `timeoutMs`, `workdir`, `run_in_background`, `sandbox_permissions`, `justification`) with `justification` empty every time, and retried the same command ten times, alternating the requested mode between `danger-full-access` and `workspace-write`, never dropping either field. Its reasoning summaries read `Considering schema field omission`, `Assessing parameter requirements for schema`, `Planning custom schema handling`: it was trying to satisfy a requirement it believed the schema imposed. Nothing imposed it — the wire schema lists only `command` and `description` as required and carries no `strict` flag — but the harness read a present field as a request, and a refusal whose remedy is "send fewer properties" cannot be satisfied by a model that always sends them all. The command never ran.

## Decision

The escalation arguments are judged against the mode the call would otherwise run under. An ask that cannot widen that mode — the call already runs at the requested mode or wider — is **ignored**: the call proceeds under its standing policy, and `validateEscalationArgs` returns `'ignored'` so the tool skips the approval step. An ask that *could* widen the call still needs its pairing: a request without a reason, a reason driving nothing, or a blank reason is refused. An unresolvable mode (no confining executor) keeps the pairing rules.

`isStrictlyWider` stays the one home for the ladder, and `approveEscalation` still enforces it for any caller that reaches the approval step without that judgement: the tools judge the ask first, the grant path refuses independently.

An ignored ask is visible where the work happened. `tool-bash` and `tool-pwsh` add an `escalationIgnored` fact to their canonical run result when the ask was ignored, and the renderer emits `[sandbox: escalation to "<requested>" ignored — this call ran at "<mode>" mode]` (`escalationIgnoredMarker`) beside the existing denial and hint markers. That fact is an output-schema property, so it reaches the model through the rendered result rather than through the arguments it must supply — and PTC compositions, which render tool output types into their system prompt, show it in that declaration too. The filesystem and `run_code` families ignore a redundant ask too, without the marker — their results carry no sandbox facts to attach it to.

The description prose keeps the earlier decision's trigger: the `[sandbox: escalation available` marker is the only sanction for a retry, an argument error is not a denial, and the `sandbox_permissions` field text in all four families says the same.

## Alternatives considered

**Refuse the redundant ask, with the remedy named.** The first decision on this problem, and it worked as designed: one instructional refusal instead of four. Then a model that always fills every property met it ten times and never ran its command. A refusal whose remedy is "omit these fields" is unusable against a model that cannot; the failure is not in the wording but in depending on omission at all.

**Treat the field's presence as intent.** That is the assumption that failed: `justification: ""` was not a reason and `sandbox_permissions` was not a request. Presence in a filled-in schema is not intent, so the decision depends on the ask's effect — can it widen this call? — rather than on the field's existence.

**Stop advertising the fields when they cannot be honored.** The tool schema is built once per composition while the mode and approval policy are per-session facts; a `danger-full-access` composition still wants the lever for a session switched narrower, which is why `ESCALATION_TARGETS` stays whole. Suppressing the fields per session would need a per-session parameter set the registry does not provide.

**Ignore silently.** The earlier decision rejected any no-op as rewarding speculative escalation. Ignoring is still what happens, but with the result marker the model is told the field changed nothing, so the call does not read as a successful escalation and the transcript keeps the fact. What changed the judgement is the measured cost: silence is a smaller risk than a command that never runs.

**Ignore only when the justification is blank.** That would swallow a grantable ask that arrived without its sentence instead of refusing it, and it would still refuse the legible case — `danger-full-access` requested at `danger-full-access` with a reason.

## Consequences

A model that fills every declared property can run commands in a session whose mode it cannot exceed; an ask that could have widened the call is unchanged, and a malformed ask that could have widened it still fails closed.

`escalation.spec.ts` pins the decision table (a redundant ask returns `'ignored'` whatever its pairing; a grantable ask keeps its pairing errors), the ignored marker's text, and `approveEscalation`'s non-widening guard. The bash and pwsh suites assert that a redundant ask runs the command with no approval request and reports the marker; the filesystem suite asserts the mutation happens with no approval ask.

The bash, pwsh, and four `sandbox_permissions` field descriptions changed text the snapshot corpus pins, so the `session` and `sdk` prompt and schema sidecars were refreshed and the derived fixtures that refresh does not rewrite were brought to the same text; `docs/tool-catalog.md` regenerated. The `escalationIgnored` output property is declared in the pinned prompt and schema sidecars (PTC renders tool output types), so those fixtures moved with it.

No durable, credential, or session-format behavior changes: the escalation vocabulary, the approval channel, and a grant's scope are as they were, and a redundant ask grants nothing the call did not already have.
