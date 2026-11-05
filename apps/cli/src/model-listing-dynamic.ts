/**
 * Parse `--model-listing-dynamic id=url[,groupByProviders=true|false][,keyEnv=ENV]`.
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
}

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
 * @throws Error when the token is not `id=url` or the URL is not http(s).
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
    break
  }
  const baseURL = rest.trim()
  if (baseURL.length === 0) throw new Error('needs id=url')
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`invalid url ${baseURL}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid url ${baseURL}`)
  }
  return {
    id,
    baseURL,
    groupByProviders: groupByProviders ?? true,
    apiKeyEnv: keyEnv ?? defaultApiKeyEnv(id),
  }
}
