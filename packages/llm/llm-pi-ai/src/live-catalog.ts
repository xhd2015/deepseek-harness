/**
 * Dynamic model listing for hand-declared pi-ai routes and launcher
 * `--model-listing-dynamic` shells. A listing is `GET {origin}/v1/models`.
 * `groupByProviders` splits rows by `owned_by` into `{shell}-{owned_by}`
 * routes; otherwise the shell id is the one served provider. A shell that names
 * an `agentRunner` appends it as `?agent-runner=`, letting a gateway that serves
 * per-client variants return only the variant that runner can use.
 *
 * @module dsh-llm-pi-ai/live-catalog
 */

import type {} from '@deepseek-ai/cordis'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiModality, PiAiModelOverride, PiAiModelProfile, PiAiReasoningEfforts } from './catalog.ts'
import { THINKING_LEVELS } from './catalog.ts'
import { resolveProfiles } from './config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'

/** Default first-load wait for a live listing. */
export const DEFAULT_MODELS_TIMEOUT_MS = 30_000

/** Default age after which a successful listing is refreshed in the background. */
export const DEFAULT_MODELS_MAX_AGE_MS = 3_600_000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher `--model-listing-dynamic` shells; omitted when the process named none. */
    modelListingDynamic?: { get(): readonly ModelListingDynamicSpec[] }
  }
}

/** One `--model-listing-dynamic` shell after parsing. */
export interface ModelListingDynamicSpec {
  /** Route prefix / shell id. */
  id: string
  /** Gateway origin or OpenAI-style base, including optional `/v1`. */
  baseURL: string
  /** When true, split listing rows by `owned_by`. Flag default is true. */
  groupByProviders: boolean
  /** Credential environment name resolved per request. */
  apiKeyEnv: string
  /**
   * Runner sent to the gateway as `?agent-runner=`, from the flag's
   * `,agent-runner=NAME` suffix. Omitted, the listing keeps every variant the
   * gateway knows.
   */
  agentRunner?: string
}

/** One row of an inspect listing after unknown fields are dropped. */
export interface LiveListingRow {
  id: string
  name: string
  ownedBy?: string
  protocol?: string
  contextWindow?: number
  maxTokens?: number
  input: PiAiModality[]
  reasoningEfforts?: PiAiReasoningEfforts
}

/** Inputs one live shell needs besides the listing body. */
export interface LiveCatalogShell {
  id: string
  baseURL: string
  groupByProviders: boolean
  apiKeyEnv?: string
  /**
   * Client runner reported to the gateway as `?agent-runner=`, letting it return
   * only the variant that runner can use. Omitted, the listing keeps every
   * variant.
   */
  agentRunner?: string
  displayName?: string
  modelOverrides?: Record<string, PiAiModelOverride>
  headers?: Readonly<Record<string, string>>
  timeoutMs: number
  maxAgeMs: number
}

/** Credential lookup used while probing a listing. */
export type LiveCatalogResolveKey = (apiKeyEnv: string | undefined) => Promise<string | undefined>

const DEFAULT_LIVE_INPUT: readonly PiAiModality[] = ['text', 'image']

const DEFAULT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Credential env name derived from a shell id: `llm-proxy` → `LLM_PROXY_API_KEY`.
 * @param id - shell id from the flag or providers dict key.
 * @returns the env name.
 */
export function defaultApiKeyEnv(id: string): string {
  const body = id.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase()
  return `${body}_API_KEY`
}

/**
 * Strip a trailing `/v1` so openai and anthropic request URLs can be derived.
 * @param baseURL - configured origin or `/v1` endpoint.
 * @returns origin without a trailing slash.
 */
export function listingOrigin(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/**
 * Request endpoint for one synthesized route.
 * @param origin - listing origin.
 * @param protocol - pi-ai api name.
 * @returns anthropic origin, otherwise `{origin}/v1`.
 */
export function requestBaseURLForProtocol(origin: string, protocol: string): string {
  return protocol === 'anthropic-messages' ? origin : `${origin}/v1`
}

function identityEfforts(keys: readonly string[]): PiAiReasoningEfforts | undefined {
  const mapping: PiAiReasoningEfforts = {}
  let any = false
  for (const key of keys) {
    if (!(THINKING_LEVELS as readonly string[]).includes(key)) continue
    mapping[key as keyof PiAiReasoningEfforts] = key
    any = true
  }
  return any ? mapping : undefined
}

function isModality(value: unknown): value is PiAiModality {
  return typeof value === 'string' && (DEFAULT_LIVE_INPUT as readonly string[]).includes(value)
}

function modalitiesOf(raw: unknown): PiAiModality[] {
  if (!Array.isArray(raw)) return [...DEFAULT_LIVE_INPUT]
  const input = raw.filter(isModality)
  return input.length > 0 ? input : [...DEFAULT_LIVE_INPUT]
}

function reasoningOf(raw: unknown): PiAiReasoningEfforts | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return identityEfforts(DEFAULT_EFFORTS)
  }
  const record = raw as { disabled?: unknown; efforts?: unknown }
  if (record.disabled === true) return undefined
  if (Array.isArray(record.efforts)) {
    const keys = record.efforts.filter((item): item is string => typeof item === 'string')
    return identityEfforts(keys) ?? identityEfforts(DEFAULT_EFFORTS)
  }
  return identityEfforts(DEFAULT_EFFORTS)
}

function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * Parse a `GET /models` JSON body into live rows. Unknown fields are ignored.
 * @param body - parsed JSON.
 * @returns usable rows in listing order.
 */
export function parseLiveListing(body: unknown): LiveListingRow[] {
  const listing = body as { data?: unknown } | null
  const data = listing?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array',
      'DISCOVERY_FAILED',
    )
  }
  const rows: LiveListingRow[] = []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const id = label(entry.id)
    if (id === undefined) continue
    const name = label(entry.display_name, entry.displayName, entry.name) ?? id
    const ownedBy = label(entry.owned_by)
    const protocol = label(entry.protocol)
    const contextWindow = capacity(entry.context_window, entry.contextWindow, entry.context_length)
    const maxTokens = capacity(entry.max_tokens, entry.maxTokens, entry.max_output_tokens)
    rows.push({
      id,
      name,
      ...ownedBy === undefined ? {} : { ownedBy },
      ...protocol === undefined ? {} : { protocol },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      input: modalitiesOf(entry.input_modalities),
      ...(() => {
        const efforts = reasoningOf(entry.reasoning)
        return efforts === undefined ? {} : { reasoningEfforts: efforts }
      })(),
    })
  }
  return rows
}

function mergeOverride(model: PiAiModelProfile, override: PiAiModelOverride | undefined): PiAiModelProfile {
  if (override === undefined) return model
  return { ...model, ...override, id: model.id }
}

function modelProfileOf(row: LiveListingRow, overrides: Record<string, PiAiModelOverride> | undefined): PiAiModelProfile {
  return mergeOverride({
    id: row.id,
    name: row.name,
    input: row.input,
    ...row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow },
    ...row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens },
    ...row.reasoningEfforts === undefined ? {} : { reasoningEfforts: row.reasoningEfforts },
  }, overrides?.[row.id])
}

/**
 * Turn listing rows into resolved pi-ai provider routes for one shell.
 * @param shell - live shell.
 * @param rows - parsed listing.
 * @returns synthesized routes; empty when grouping finds no `owned_by`.
 */
export function profilesFromListing(
  shell: LiveCatalogShell,
  rows: readonly LiveListingRow[],
): Map<string, ResolvedPiAiProviderProfile> {
  const origin = listingOrigin(shell.baseURL)
  const providers: Record<string, PiAiProviderProfile> = {}
  if (!shell.groupByProviders) {
    const protocol = rows.find(row => row.protocol !== undefined)?.protocol ?? 'openai-responses'
    const models = rows
      .filter(row => row.protocol === undefined || row.protocol === protocol)
      .map(row => modelProfileOf(row, shell.modelOverrides))
    if (models.length === 0) return new Map()
    providers[shell.id] = {
      displayName: shell.displayName ?? shell.id,
      api: protocol,
      baseURL: requestBaseURLForProtocol(origin, protocol),
      ...shell.apiKeyEnv === undefined ? {} : { apiKeyEnv: shell.apiKeyEnv },
      ...shell.headers === undefined ? {} : { headers: { ...shell.headers } },
      models,
      defaultInput: [...DEFAULT_LIVE_INPUT],
    }
    return resolveProfiles(providers)
  }
  const groups = new Map<string, LiveListingRow[]>()
  for (const row of rows) {
    if (row.ownedBy === undefined) continue
    const list = groups.get(row.ownedBy) ?? []
    list.push(row)
    groups.set(row.ownedBy, list)
  }
  for (const [ownedBy, group] of groups) {
    const protocols = new Set(group.map(row => row.protocol).filter((item): item is string => item !== undefined))
    if (protocols.size > 1) continue
    const protocol = [...protocols][0] ?? 'openai-responses'
    const models = group
      .filter(row => row.protocol === undefined || row.protocol === protocol)
      .map(row => modelProfileOf(row, shell.modelOverrides))
    if (models.length === 0) continue
    providers[`${shell.id}-${ownedBy}`] = {
      displayName: ownedBy,
      api: protocol,
      baseURL: requestBaseURLForProtocol(origin, protocol),
      ...shell.apiKeyEnv === undefined ? {} : { apiKeyEnv: shell.apiKeyEnv },
      ...shell.headers === undefined ? {} : { headers: { ...shell.headers } },
      models,
      defaultInput: [...DEFAULT_LIVE_INPUT],
    }
  }
  return resolveProfiles(providers)
}

async function fetchListing(shell: LiveCatalogShell, resolveKey: LiveCatalogResolveKey, signal?: AbortSignal): Promise<LiveListingRow[]> {
  const url = new URL(`${listingOrigin(shell.baseURL)}/v1/models`)
  // The gateway answers for the declared runner; without one it lists every
  // variant as a model of its own.
  if (shell.agentRunner !== undefined) url.searchParams.set('agent-runner', shell.agentRunner)
  const apiKey = await resolveKey(shell.apiKeyEnv)
  const headers = new Headers(shell.headers === undefined ? undefined : Object.entries(shell.headers))
  headers.set('accept', 'application/json')
  if (apiKey !== undefined && apiKey.length > 0) headers.set('authorization', `Bearer ${apiKey}`)
  for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers, ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    if (signal?.aborted) throw new LlmError('model listing aborted by caller', 'ABORTED', { cause: error })
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    // A launcher shell whose derived name resolved to nothing sent the
    // placeholder, so a rejection is the only report that a real credential is
    // needed; name the knob that supplies one.
    const hint = response.status === 401 || response.status === 403
      ? '; the gateway rejected the credential, so supply one with ,keyEnv=NAME on the flag or apiKeyEnv on the profile'
      : ''
    throw new LlmError(`${url} answered ${response.status}${hint}`, 'DISCOVERY_FAILED')
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return parseLiveListing(body)
}

/** Runtime cache and refresh for every live shell on this plugin instance. */
export interface LiveCatalogController {
  /** Current synthesized routes (live ids replace static ones of the same name). */
  current(): ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Wait until every shell has completed its first probe (success or failure). */
  ready(): Promise<void>
  /** Begin the first probe of every shell. */
  start(): void
  /** Stop refresh timers. */
  dispose(): void
}

/**
 * Run listing probes for the given shells and keep last-known-good routes.
 * @param shells - live shells from flags and `modelListingMode: dynamic` profiles.
 * @param resolveKey - credential lookup.
 * @param onChange - invoked after a successful listing that changes routes.
 * @returns the controller.
 */
export function createLiveCatalogController(
  shells: readonly LiveCatalogShell[],
  resolveKey: LiveCatalogResolveKey,
  onChange: () => void,
): LiveCatalogController {
  let routes = new Map<string, ResolvedPiAiProviderProfile>()
  const timers: ReturnType<typeof setTimeout>[] = []
  let disposed = false
  let first: Promise<void>[] = []

  async function probe(shell: LiveCatalogShell, background: boolean): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, shell.timeoutMs)
    try {
      const rows = await fetchListing(shell, resolveKey, controller.signal)
      if (disposed) return
      const next = profilesFromListing(shell, rows)
      const merged = new Map(routes)
      for (const key of [...merged.keys()]) {
        if (key === shell.id || key.startsWith(`${shell.id}-`)) merged.delete(key)
      }
      for (const [id, profile] of next) merged.set(id, profile)
      routes = merged
      onChange()
    } catch {
      // Keep last-known-good; an empty first probe leaves no routes for this shell.
    } finally {
      clearTimeout(timer)
      if (!disposed && background) {
        timers.push(setTimeout(() => { void probe(shell, true) }, shell.maxAgeMs))
      }
    }
  }

  return {
    current: () => routes,
    ready: () => Promise.all(first).then(() => undefined),
    start() {
      if (first.length > 0 || shells.length === 0) return
      first = shells.map(shell => probe(shell, true))
    },
    dispose() {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.length = 0
    },
  }
}
