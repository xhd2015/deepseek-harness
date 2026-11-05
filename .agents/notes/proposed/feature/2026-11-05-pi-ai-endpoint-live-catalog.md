# Agent Note: Pi-ai custom routes can serve an endpoint listing

Status: proposed

English | [中文](2026-11-05-pi-ai-endpoint-live-catalog.zh.md)

## Problem

A pi-ai route the installed catalog does not describe must list every model in `cordis.patch.yml`. `discoverModels` already interrogates `GET {baseURL}/models`, but the reply is a candidate list the Models page offers for adoption; nothing is stored, and the patch remains the only catalog the adapter serves. Adding or retiring a gateway model means editing that list (or merging a generated `dsh-models` fragment) even when the endpoint already advertises the id.

The GUI picker reads `listModels`. A custom route without a patch entry cannot be selected. In-flight pi-ai snapshots treat the settings document as the catalog and drop any upstream dynamic refresh, so a gateway that changes its listing never reaches the picker until the user writes the file again.

[`llm-deepseek-account`](../../implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.md) already loads `GET /models` per credential, refreshes in the background, keeps last-known-good in memory, and forbids a configurable `models` list. That pattern is confined to the DeepSeek account route.

## Proposal

Give a **custom** pi-ai route an explicit live catalog, modeled on the account route, without changing installed-catalog routes or writing listings into the patch.

llm-proxy work is independent and lives in [`external/llm-proxy/docs/live-catalog.md`](../../../../external/llm-proxy/docs/live-catalog.md). That config keeps a nested `modelListing` object (`mode: "dynamic"`); its `models` array is the startup seed and, after the first successful fetch, the override list keyed by `(protocol, provider, providerModelName)`, including `excluded`. This DSH proposal consumes a listing endpoint; it does not require llm-proxy changes to be correct, but it benefits from that inspect API’s extension fields (`protocol`, `context_window`, `input_modalities`, `reasoning`). The pi-ai field `catalog: endpoint` is a different discriminant in a different file; it is not llm-proxy’s `modelListing`.

### Config

A route the installed catalog does not describe may set `catalog: endpoint` and omit `models`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      llm-proxy-commandcode:
        displayName: Command Code (llm-proxy)
        apiKeyEnv: COMMANDCODE_API_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:8890
        catalog: endpoint
        modelsMaxAgeMs: 3600000
        defaultInput: [text, image]
        modelOverrides:
          deepseek/deepseek-v4-flash:
            reasoningEfforts: { high: high, xhigh: xhigh, max: max }
```

`catalog: endpoint` with a `models` list is refused at resolve (same fail-loud as the account route rejecting `models`). Installed-catalog routes must not set `catalog: endpoint`; omitting `models` there still means “serve the installed catalog” with no network call.

`api` and `baseURL` remain required on a custom live route. One pi-ai route still speaks one protocol. A gateway that serves both Anthropic Messages and OpenAI Responses is two DSH providers. Collapsing those into one endpoint that lists `protocol` per model is deferred.

`modelsTimeoutMs` / `modelsMaxAgeMs` match the account route’s fields. Default `modelsMaxAgeMs` is `3600000` (1h) on this path, not the account route’s ten minutes. `modelOverrides` overlays listing rows by id; an override naming an id the listing never returned is a provider diagnostic and does not hide other models.

### Runtime

Reuse the account catalog mechanics inside `llm-pi-ai` for `catalog: endpoint` routes only:

1. Scope the cache by listing URL and credential fingerprint.
2. First `listModels` / `prepareCall` waits for the load up to `modelsTimeoutMs`. Later calls return the cached listing immediately and refresh in the background when older than `modelsMaxAgeMs`.
3. A failed or empty load keeps the previous listing. Before any success, the route advertises no models and requests fail loud (`UNKNOWN_MODEL` / empty picker), not a guessed catalog — there is no bundled pi-ai catalog for a hand-declared route.
4. A successful refresh builds a new adapter snapshot. In-flight `prepareCall` snapshots stay on the generation they captured.
5. Publish the existing provider-topology notification so the Web catalog rebuilds.
6. Do not write the listing into settings, `cordis.patch.yml`, or a durable cache. Last-known-good is process memory, as on the account route.

Listing transport stays the existing discovery parser (`GET {baseURL}/models` or Anthropic `GET /v1/models`). When the body carries extension fields this adapter already understands (name, context window, max tokens, input modalities), use them; missing fields fall through `defaultContextWindow` / `defaultMaxTokens` / `defaultInput` (default `[text]`) and reasoning-off. Do not invent image support or a protocol from the URL.

Unlisted ids are not passed through. A session whose saved model disappeared from the listing shows it unavailable; a request naming it fails before provider I/O.

### GUI

A `catalog: endpoint` provider has no model-list editor and no “Fetch available models → Add selected → Save” path. The Models page shows a read-only listing, last-refresh age, a refresh action, and override diagnostics, the same posture as the DeepSeek account card. Creating the provider still requires id, `api`, `baseURL`, and credential; it does not require a model row.

### `dsh-models`

Until this ships, llm-proxy’s `dsh-models` export may still emit a full `models:` list. After this ships, that export should emit `catalog: endpoint` shells (no `models:`) for live proxy routes. That exporter change belongs in llm-proxy and is not a DSH load-bearing dependency.

## Alternatives considered

**Keep Fetch-and-save as the only custom-route catalog.** Discovery already exists. It still requires a human to adopt rows into the patch after every gateway change, which is the cost this proposal removes.

**Treat an omitted `models` list on a custom route as live without a `catalog` field.** Installed-catalog routes already use omission to mean “shipped catalog, no network.” Silent live mode on a misspelled provider id would probe a gateway the user did not intend, or fail with “resolves no models” as today. The discriminant must be explicit.

**Write listings back into `cordis.patch.yml`.** That automates today’s merge and keeps the settings document as source of truth, which is what `reuseCatalogProvider` currently assumes. It races the user, needs backup/lock behavior the llm-proxy editor already grew for DSH fragments, and cannot refresh without a write.

**One DSH provider for a mixed-protocol llm-proxy listener.** pi-ai materializes one `api` per route. Splitting internally from listing `protocol` fields is a later change; v1 keeps one route per protocol, which is how `dsh-models` already groups.

**Persist last-known-good on disk.** The account route rejected durable cache because a bundled catalog covers offline starts. A custom route has no bundle; a disk cache would add a persistence format for a process-local listing. Empty-picker plus fail-loud on a cold start without a listing is the smaller contract.

**Pass through unlisted ids on a live route.** Core `LlmRuntime` allows unlisted ids; pi-ai custom routes currently throw `UNKNOWN_MODEL`. Live catalog does not widen that. A prefix-shaped typo must not become an upstream request.

**Generalize the DeepSeek account package to every adapter.** Account listings carry `client_requirements` and merge over a bundled Messages catalog. Gateway listings do not. The cache/refresh object can be paralleled; the gating and bundle merge stay in `llm-deepseek-account`.

## Acceptance criteria

- A custom route with `catalog: endpoint`, `api`, `baseURL`, and no `models` loads; `listModels` equals the listing ids after the first successful fetch.
- The same route with a `models` list is refused where it is written.
- An installed-catalog route that omits `models` still answers from the shipped catalog and does not contact the network.
- First fetch slower than `modelsTimeoutMs` leaves that provider’s picker empty with a diagnostic; other providers stay selectable.
- A later listing that adds or removes an id updates `listModels` and the Web catalog; a `prepareCall` started before the refresh keeps its snapshot.
- A failed refresh keeps the previous listing; a process that has never succeeded lists nothing and refuses requests for named ids.
- `modelOverrides` retouch window / reasoning / input on a listed id; an unknown override id is a directory diagnostic.
- The Models page for a live route has no adopt-and-save model editor.
- A saved session model missing from the latest listing is shown unavailable and cannot be submitted.

## Risks

Live `listModels` can wait on the first fetch, so a Web catalog build that today returns from memory may stall up to `modelsTimeoutMs` per live route. Bound the wait; isolate failures per provider so one down gateway does not empty the picker.

Gateway listings are often larger than a curated patch (an OpenRouter-style `/models`, or Command Code’s compiled 20+ ids versus two hand-picked rows). Without include filters this lives on the **endpoint** (llm-proxy `include` / a curated static patch). DSH v1 adopts the listing as advertised; filtering is a follow-up field if product needs it on the DSH side.

Missing listing metadata makes compaction, image offload, and reasoning UI fall back to route defaults. Wrong `defaultInput: [text, image]` on a text-only gateway is a configuration error, not something the listing can disprove.

This does not change session format, request headers, or model-visible content. Provider and model ids in the log remain the route key and the listing id (or override alias) the user selected.
