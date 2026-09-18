# Agent Note: Refuse one model, not the whole namespace

Status: implemented

English | [中文](2026-09-18-refuse-one-model-not-the-namespace.zh.md)

## Problem

A `llm-pi-ai` settings section is validated as one namespace, so a value the schema rejects refuses every provider in it. A single misspelled level key — `reasoningEfforts: { max: max, ultra: ultra }`, where `ultra` is a wire spelling rather than one of pi-ai's levels — cost the whole `llm-pi-ai` section: `grok`, `codex`, `ais`, and the edited provider all kept their previous state, the route the key named lost its model, and nothing on screen said so. `SettingsProvider.publish` contains the failure as `settings: keeping last good "llm-pi-ai" after invalid stored section`, which reaches the server log only; the Models page rendered the last good rows and the picker offered the last good models, so the user's only signal was the silence.

The blast radius is wider than the invisible row. A live refusal leaves the stored section poisoned: any later write to the namespace re-resolves the whole section, so editing an unrelated provider is refused with the codex error, and the array element the offending key lives in cannot be addressed by a path op at all. On a cold start the section fails registration — `register` resolves inline and there is no last good value yet — so the namespace disappears from `settings.describe()`: every pi-ai route drops, and a repair write answers `settings namespace "llm-pi-ai" is not registered`. The state that most needs the editing surface is the state that has none, and the fix required hand-editing the document.

## Decision

`reasoningEfforts` admits any key at the schema boundary, and resolution refuses the one model entry that names a level pi-ai does not know. The check runs before the declared set is read, so a dict carrying only misspellings names them instead of reporting that it offers no level, and it throws `PiAiCatalogError` from inside `resolveRouteModels`' per-entry catch. That single position inherits both behaviors the codebase already has: deferred validation — the stored-read path — records the message in `modelErrors` and drops only that entry, while strict resolution refuses the write that introduced it through `assertServiceable`.

A refused model is listed, not hidden. `llm-pi-ai` reports its `modelErrors` in the configurable-provider directory, and its adapter's `listModels` returns the served models followed by one entry per refusal carrying the new `LlmModelInfo.unavailable`. The composer picker renders that entry disabled with the message, the `/model` popup marks it unavailable and answers a pick with the adapter's own text, and the Models page shows the same text on the model's row — which is where the field the message names is edited. `ModelCatalogModel.unavailable` carries it through the host catalog, and `buildModelCatalog` projects a refused entry from the listing it already has rather than resolving metadata: that resolution throws the same refusal, and the builder's per-provider catch would have turned it into a group-level failure that hides the route's healthy models.

A selection already standing on a refused model blocks the composer through the mechanism the seam already has: `ModelDirectory` reads the refusal off the selected model and publishes it as `unavailableReason`, so `ctx.conversation.blocks` carries the adapter's text instead of this plugin's generic copy. Only an explicit refusal blocks — absence from the catalog groups still never does, because a route serving a model it stopped advertising stays usable.

The reachable spelling of an `ultra` level is `max: ultra`: the selectable keys are pi-ai's own level set, and the value is what dispatch sends.

This refines the [repairable pi-ai settings decision](../bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.md): tolerating catalog diagnostics at registration while writes strictly check changed providers is unchanged, and a refused model moves from existing in settings alone to being listed and unselectable.

## Alternatives considered

**Report the refusal in the descriptor instead.** `SettingsNamespaceView` could carry the refusing namespace plus the schemastery message, and the Models page could render a banner without any pi-ai change. It names the section rather than the model, it leaves the offending entry unlisted, and it does nothing for the cold-start case where registration fails before any namespace view exists.

**Resolve per provider inside the settings seam.** The seam cannot split one namespace into independently validatable units: only the owner knows which subtree is one model entry. Per-model granularity has to come from the owner's own resolution.

**Keep the current `serviceableModels` filter and hide the refused entry.** This is what the codebase does for catalog drift, and it is why the user could not see what the document configured. The row that would carry the diagnostic is exactly the row that disappears.

**Loosen the key type without a resolution check.** Measured: `{ low: low, max: max, ultra: ultra }` then resolves with no diagnostic at all — all three models served and `modelErrors` empty — because both the declared set and the thinking-level map are built by iterating `THINKING_LEVELS`. A silently ignored field is worse than the refusal it replaces.

**Add `ultra` as a thinking level.** The level set belongs to pi-ai (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `ultra` is a value the codex proxy accepts on the wire, so a level labelled "Ultra" in the picker is not expressible without an upstream change.

**Broaden the change to every profile vocabulary.** `api`, the `compat` vocabularies, `transport`, `cacheRetention`, `input`, and the numeric bounds trap a typo the same way. Each needs its own per-model `PiAiCatalogError` audit to avoid becoming a route-level failure, so the remaining fields stay as they are.

## Consequences

The class is `reasoningEfforts` only; the same trap remains for the profile vocabulary listed above.

The write path keeps refusing the value, but the message now comes from resolution rather than the schema: `config.spec.ts` asserts the route- and model-naming text through `assertServiceable`, and `{ high: 42 }` — a type error, not a vocabulary one — still fails the schema. `dynamic-config.spec.ts` pins the listing posture (served entry plus a refused one carrying the reason), the per-model directory diagnostic, the request refused with `INVALID_CONFIG` before provider I/O, an unrelated provider staying editable, and the array replacement that repairs it. `session-models.host.spec.ts` pins that a refused entry does not collapse its provider group. Client tests pin the disabled row with the reason, the popup badge and refusal, the composer block carrying the adapter's text, keyboard navigation stepping over the disabled row, and the existing rule that absence from the catalog never blocks.

A document with several mistyped models reports one at a time: the route-level `error` is the first entry in `modelErrors`, while the per-model map carries them all to the surfaces that render rows.

Nothing durable or model-visible changes. `reasoningEfforts` is configuration, the refusal is derived per operation, and no session event, wire payload, or persisted record gains a field.
