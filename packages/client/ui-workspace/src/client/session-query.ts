/**
 * Session id in the Web GUI query string (`?session=`): `dsh web open` and
 * in-app selection both write it so a copied URL restores that Session.
 * @module @deepseek-ai/dsh-client-ui-workspace/session-query
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Query key naming the selected Session. */
export const SESSION_QUERY = 'session'
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u

/** Parsed `session` query. */
export type SessionQuery =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'id'; readonly id: SessionId }

/**
 * Parse the `session` query parameter.
 * @param search - `window.location.search`, including the leading `?` when present.
 * @returns absence, a well-formed Session id, or a present but unusable value.
 */
export function parseSessionQuery(search: string): SessionQuery {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const values = params.getAll(SESSION_QUERY)
  if (values.length === 0) return { kind: 'absent' }
  if (values.length !== 1) return { kind: 'malformed' }
  const value = values[0]
  if (value === undefined || value === '' || !SESSION_ID_PATTERN.test(value)) return { kind: 'malformed' }
  return { kind: 'id', id: value as SessionId }
}

/**
 * Parse a single well-formed `session` query parameter.
 * @param search - `window.location.search`, including the leading `?` when present.
 * @returns the Session id, or `undefined` when absent or malformed.
 */
export function sessionIdFromSearch(search: string): SessionId | undefined {
  const parsed = parseSessionQuery(search)
  return parsed.kind === 'id' ? parsed.id : undefined
}

/**
 * Write or remove `?session=` without adding a history entry.
 * @param sessionId - selected Session, or `undefined` to drop the parameter.
 */
export function replaceSessionQuery(sessionId: SessionId | undefined): void {
  if (globalThis.location === undefined || globalThis.history === undefined) return
  const url = new URL(globalThis.location.href)
  const present = url.searchParams.getAll(SESSION_QUERY)
  if (sessionId === undefined) {
    if (present.length === 0) return
    url.searchParams.delete(SESSION_QUERY)
  } else if (present.length === 1 && present[0] === sessionId) {
    return
  } else {
    url.searchParams.set(SESSION_QUERY, sessionId)
  }
  globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}
