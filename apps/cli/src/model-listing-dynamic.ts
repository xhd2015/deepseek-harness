/**
 * Parse `--model-listing-dynamic id=url[,groupByProviders=true|false][,keyEnv=ENV][,agent-runner=NAME]`.
 * Kept in the launcher so apps/cli does not compile `@deepseek-ai/dsh-llm-pi-ai`.
 * @module @deepseek-ai/dsh/model-listing-dynamic
 */

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
   * Runner reported to the gateway as `?agent-runner=`. A gateway that serves
   * one upstream model per-client variant narrows the listing to this runner's
   * variant; omitted, the listing keeps every variant.
   */
  agentRunner?: string
}

/** Suffixes a value may carry, named in every URL rejection. */
const URL_OPTION_HINT = 'put options after the url as comma suffixes: groupByProviders, keyEnv, agent-runner'

/**
 * Credential env name derived from a shell id: `llm-proxy` → `LLM_PROXY_API_KEY`.
 * @param id - shell id from the flag.
 * @returns the env name.
 */
export function defaultApiKeyEnv(id: string): string {
  const body = id.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase()
  return `${body}_API_KEY`
}

/**
 * Parse one `--model-listing-dynamic` value.
 * @param raw - `id=url` plus optional suffixes.
 * @returns the spec.
 * @throws Error when the token is not `id=url`, a suffix is malformed, or the
 * URL is not http(s) or carries its own query or fragment.
 */
export function parseModelListingDynamicSpec(raw: string): ModelListingDynamicSpec {
  const trimmed = raw.trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) throw new Error('needs id=url')
  const id = trimmed.slice(0, eq).trim()
  if (id.length === 0) throw new Error('needs id=url')
  let rest = trimmed.slice(eq + 1)
  let groupByProviders: boolean | undefined
  let keyEnv: string | undefined
  let agentRunner: string | undefined
  for (;;) {
    const grouped = /,groupByProviders=(true|false)$/i.exec(rest)
    if (grouped?.[1] !== undefined) {
      groupByProviders = grouped[1].toLowerCase() === 'true'
      rest = rest.slice(0, rest.length - grouped[0].length)
      continue
    }
    const key = /,keyEnv=([^,]+)$/.exec(rest)
    if (key?.[1] !== undefined) {
      keyEnv = key[1]
      rest = rest.slice(0, rest.length - key[0].length)
      continue
    }
    const runner = /,agent-runner=([^,]*)$/.exec(rest)
    if (runner?.[1] !== undefined) {
      agentRunner = runner[1].trim()
      if (agentRunner.length === 0) throw new Error('agent-runner needs a value')
      if (!/^[A-Za-z0-9._-]+$/.test(agentRunner)) {
        throw new Error(`agent-runner ${JSON.stringify(agentRunner)} must match [A-Za-z0-9._-]+`)
      }
      rest = rest.slice(0, rest.length - runner[0].length)
      continue
    }
    break
  }
  const baseURL = rest.trim()
  if (baseURL.length === 0) throw new Error('needs id=url')
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`invalid url ${baseURL}: ${URL_OPTION_HINT}`)
  }
  // A query here would be dropped by the listing URL and corrupt the inference
  // origin, which is the same URL without `/v1`.
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`invalid url ${baseURL}: ${URL_OPTION_HINT}`)
  }
  return {
    id,
    baseURL,
    groupByProviders: groupByProviders ?? true,
    apiKeyEnv: keyEnv ?? defaultApiKeyEnv(id),
    ...agentRunner === undefined ? {} : { agentRunner },
  }
}
