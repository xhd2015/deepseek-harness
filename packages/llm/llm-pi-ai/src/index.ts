/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-proxy-providers` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import {
  createLiveCatalogController,
  DEFAULT_MODELS_MAX_AGE_MS,
  DEFAULT_MODELS_TIMEOUT_MS,
  defaultApiKeyEnv,
} from './live-catalog.ts'
import type { LiveCatalogShell, ModelListingDynamicSpec } from './live-catalog.ts'
import { registerPiAiFlows } from './login.ts'
import { providerDefaultsOf } from './provider-data.ts'
import type { PiAiRequestHeaderContext } from './types.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export type { PiAiRequestHeaderContext } from './types.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export type { ModelListingDynamicSpec } from './live-catalog.ts'
export { supportedProtocols } from './provider.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Prepare headers for one pi-ai inference call, excluding model discovery.
     * Listeners run synchronously and must call next(); they may edit only the
     * request-owned headers and must not retain them. Throws fail the call with
     * REQUEST_HEADERS before inference I/O. Harness attribution wins afterward.
     * Non-TypeError messages are user-visible and must exclude secrets. TypeError
     * details and non-Error values are replaced with safe guidance.
     * @mode waterfall
     * @param request - immutable routing metadata from the exact prepared call.
     * @param headers - fresh profile headers, shared only within this dispatch.
     * @param next - continue header preparation through the remaining listeners.
     * @returns headers passed to pi-ai after Harness attribution is applied.
     */
    'llm-pi-ai/request-headers'(request: PiAiRequestHeaderContext, headers: Headers, next: () => Headers): Headers
  }
}

const NS = 'llm-pi-ai'

/**
 * Credential value sent for a launcher shell whose derived env name resolves to
 * nothing. Gateways that ignore client credentials never read it; one that
 * authenticates answers 401, and the listing failure names the flag's `keyEnv`.
 */
const LIVE_CATALOG_CREDENTIAL = 'dsh-live-listing'

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (
    provider: string,
    displayName: string,
    error?: string,
    modelErrors?: ReadonlyMap<string, string>,
  ): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === undefined,
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
      // Named per model so the Models page shows a refused entry beside the
      // field that refused it, and so a route-level `error` no longer stands
      // in for the first of them.
      ...modelErrors === undefined || modelErrors.size === 0
        ? {}
        : { modelErrors: Object.fromEntries(modelErrors) },
    })
  }
  for (const provider of catalogProviderIds()) declare(provider, provider)
  for (const [provider, profile] of profiles) {
    declare(provider, profile.displayName, profile.catalogError, profile.modelErrors)
  }
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const resolvedConfig = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as import('./config.ts').Options['providers'], 'deferred')
    lastRaw = raw
    memoized = next
    return next
  }
  /** Routes served from configuration alone; a dynamic listing shell is not one. */
  const servedStatic = (): Map<string, ResolvedPiAiProviderProfile> => {
    const served = new Map<string, ResolvedPiAiProviderProfile>()
    for (const [provider, profile] of resolvedConfig()) {
      if (profile.modelListingMode === 'dynamic') continue
      served.set(provider, profile)
    }
    return served
  }
  /** Routes a live listing currently serves, merged over the static ones. */
  let liveRoutes: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map()
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const merged = servedStatic()
    for (const [provider, profile] of liveRoutes) merged.set(provider, profile)
    return merged
  }
  resolvedConfig()
  ctx.on('internal/config', (fiber, next) => {
    const raw: unknown = next()
    if (fiber !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  // `--model-listing-dynamic id=url` names no credential; the environment name
  // is derived from the id here. Because the deployment never wrote that
  // reference, resolving it to nothing is not a misconfiguration to report —
  // and a gateway that ignores client credentials still needs a value for pi-ai
  // to send. References the deployment did write keep the fail-loud path below.
  const specs = ctx.get('modelListingDynamic')?.get() ?? []
  const derivedCredentialRefs: ReadonlySet<string> = new Set(specs.map(spec => defaultApiKeyEnv(spec.id)))
  const injectedCredential = (ref: string): string | undefined =>
    derivedCredentialRefs.has(ref) ? LIVE_CATALOG_CREDENTIAL : undefined

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently. The launcher-derived name
    // is the one exception, and it stops at the placeholder.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    const injected = injectedCredential(ref)
    if (injected !== undefined) return injected
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const shells: LiveCatalogShell[] = []
  for (const spec of specs) {
    shells.push(shellFromSpec(spec))
  }
  for (const [id, profile] of resolvedConfig()) {
    if (profile.modelListingMode !== 'dynamic' || profile.baseURL === undefined) continue
    shells.push({
      id,
      baseURL: profile.baseURL,
      groupByProviders: profile.groupByProviders === true,
      ...profile.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv },
      displayName: profile.displayName,
      ...profile.modelOverrides === undefined ? {} : { modelOverrides: profile.modelOverrides },
      ...profile.headers === undefined ? {} : { headers: profile.headers },
      timeoutMs: profile.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
      maxAgeMs: profile.modelsMaxAgeMs ?? DEFAULT_MODELS_MAX_AGE_MS,
    })
  }
  const replacedWarning = new Set<string>()
  const live = createLiveCatalogController(
    shells,
    async (apiKeyEnv) => {
      if (apiKeyEnv === undefined) return undefined
      const credentials = ctx.get('credentials')
      const hit = credentials !== undefined
        ? (await credentials.resolve(credentialRef(apiKeyEnv)))?.value
        : launchEnvironmentOf(ctx).get(apiKeyEnv)?.value
      if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', apiKeyEnv)
      // Same rule as `resolveApiKey`: the listing probe and the requests it
      // enables must agree on how a launcher shell authenticates.
      return injectedCredential(apiKeyEnv)
    },
    () => {
      liveRoutes = live.current()
      const staticIds = servedStatic()
      for (const id of liveRoutes.keys()) {
        if (!staticIds.has(id) || replacedWarning.has(id)) continue
        replacedWarning.add(id)
        ctx.logger.warn(`llm-pi-ai: live catalog replaces static provider "${id}" from cordis.patch.yml`)
      }
      try {
        ensureRegistrationFacts()
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('llm-pi-ai: live catalog registration failed')
        ctx.logger.error(error)
      }
    },
  )
  ctx.effect(() => () => { live.dispose() }, 'llm-pi-ai: live model listing')
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    awaitLiveCatalog: () => live.ready(),
    refreshLiveCatalog: () => live.refresh(),
    auth,
    prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
    onThinkingOmitted: ({ provider, model, count }) => {
      ctx.logger.debug(`llm-pi-ai: omitted stale thinking from ${count} assistant message(s) for route "${provider}/${model}"`)
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles(), settingsNs)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()
  live.start()

  ctx.on('loader/volatile-update', () => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}

function shellFromSpec(spec: ModelListingDynamicSpec): LiveCatalogShell {
  return {
    id: spec.id,
    baseURL: spec.baseURL,
    groupByProviders: spec.groupByProviders,
    apiKeyEnv: spec.apiKeyEnv,
    ...spec.agentRunner === undefined ? {} : { agentRunner: spec.agentRunner },
    timeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
    maxAgeMs: DEFAULT_MODELS_MAX_AGE_MS,
  }
}
