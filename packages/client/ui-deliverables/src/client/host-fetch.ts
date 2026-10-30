/** The page's HTTP face for Host REST routes: the injected page transport when present, else the browser fetch. */

/** A fetch-shaped carrier for Host REST routes; the connection transport's `fetch` fits. */
export type HostFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Read one Host route through the page transport when the embedding page
 * provides one (`globalThis.__DSH_TRANSPORT__`), so proxied embedders rewrite
 * the path to their own carrier; the served web app has no transport and uses
 * the browser fetch. Resolved per call, so tests and late injection apply.
 * @param input - the route, absolute or browser-relative.
 * @param init - the request options.
 * @returns the response.
 */
export function hostFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { fetch?: HostFetch } }).__DSH_TRANSPORT__
  if (transport?.fetch) return transport.fetch(input, init ?? {})
  return fetch(input, init)
}
