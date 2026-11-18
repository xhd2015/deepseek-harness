/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

const API_PREFIX_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/

/**
 * Reject a deployment apiPrefix that is not an absolute multi-segment path.
 * @param value - candidate prefix from plugin config or a boot global.
 * @returns the same string when valid.
 */
export function assertApiPrefix(value: string): string {
  if (!API_PREFIX_PATTERN.test(value)) {
    throw new Error(
      `client-connection: apiPrefix ${JSON.stringify(value)} must be an absolute path of one or more URL segments`,
    )
  }
  return value
}

/**
 * Join a configured API prefix with a route under it.
 * @param prefix - `/api` or a nested prefix such as `/api/dsh`.
 * @param rest - path under the prefix (`remote.mux`, `/file`).
 * @returns the absolute pathname.
 */
export function joinApiPath(prefix: string, rest: string): string {
  const tail = rest.startsWith('/') ? rest.slice(1) : rest
  return `${prefix}/${tail}`
}

/**
 * Browser API prefix: transport override, then the Host-injected boot global,
 * then `/api`.
 * @returns the absolute prefix the page should address.
 */
export function readBrowserApiPrefix(): string {
  const globals = globalThis as {
    __DSH_API_PREFIX__?: unknown
    __DSH_TRANSPORT__?: { apiPrefix?: unknown }
  }
  const fromTransport = globals.__DSH_TRANSPORT__?.apiPrefix
  if (typeof fromTransport === 'string' && fromTransport !== '') return fromTransport
  const fromGlobal = globals.__DSH_API_PREFIX__
  if (typeof fromGlobal === 'string' && fromGlobal !== '') return fromGlobal
  return API_PATH
}
