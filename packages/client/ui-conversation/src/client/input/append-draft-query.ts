/**
 * Consume `?appendDraft=` once, then apply it after Host draft hydrate so
 * `DraftPersistence.adopt` cannot wipe the payload.
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DraftInput } from '../contract/draft-editor.ts'
import type { InputHub } from './hub.ts'

/** Query key whose value is appended to the Session composer, then stripped. */
export const APPEND_DRAFT_QUERY = 'appendDraft'

let pendingSessionId: string | undefined
let pendingExtra: string | undefined

function pageSearch(): string {
  return typeof location === 'undefined' ? '' : location.search
}

function sessionIdFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const values = params.getAll('session')
  if (values.length !== 1) return undefined
  const value = values[0]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Read a single `appendDraft` query value.
 * @param search - `window.location.search`, including the leading `?` when present.
 * @returns the payload, or `undefined` when absent or duplicated.
 */
export function peekAppendDraft(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const values = params.getAll(APPEND_DRAFT_QUERY)
  if (values.length !== 1) return undefined
  return values[0]
}

/**
 * Join a composer payload onto existing draft text.
 * @param current - current composer text.
 * @param extra - text to append.
 * @returns extra when the draft is blank; otherwise extra on a new line.
 */
export function joinDraft(current: string, extra: string): string {
  if (extra === '') return current
  const trimmed = current.replace(/\s+$/u, '')
  if (trimmed === '') return extra
  return `${trimmed}\n${extra}`
}

/**
 * Read `appendDraft` and drop it from the page URL without a history entry.
 * @returns the payload when a single parameter was present.
 */
export function consumeAppendDraft(): string | undefined {
  if (typeof location === 'undefined' || typeof history === 'undefined') return undefined
  const url = new URL(location.href)
  const extra = peekAppendDraft(url.search)
  if (!url.searchParams.has(APPEND_DRAFT_QUERY)) return extra
  url.searchParams.delete(APPEND_DRAFT_QUERY)
  globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return extra
}

function draftText(draft: DraftInput): string {
  return typeof draft === 'string' ? draft : draft.text
}

/**
 * Stash `appendDraft` and strip it from the URL so a refresh cannot replay it.
 */
export function captureAppendDraftFromUrl(): void {
  const extra = peekAppendDraft(pageSearch())
  const sessionId = sessionIdFromSearch(pageSearch())
  if (extra !== undefined && sessionId !== undefined) {
    pendingExtra = extra
    pendingSessionId = sessionId
  }
  consumeAppendDraft()
}

/**
 * Append a stashed `appendDraft` payload onto one Session composer.
 * @param input - Session input registry.
 * @param sessionId - Session whose composer should receive the payload.
 * @returns whether a payload was applied.
 */
export function applyPendingAppendDraft(input: InputHub, sessionId: SessionId): boolean {
  if (pendingExtra === undefined || pendingSessionId !== sessionId) return false
  const extra = pendingExtra
  try {
    const shell = input.shell(sessionId)
    const current = draftText(shell.state.getSnapshot().draft)
    pendingExtra = undefined
    pendingSessionId = undefined
    shell.setDraft(joinDraft(current, extra))
    shell.actions.persistDraft()
    return true
  } catch {
    return false
  }
}

/**
 * Capture `appendDraft` immediately, then apply when the composer exists.
 * @param input - Session input registry.
 * @param sessions - Client Session list.
 * @returns disposer for the list and popstate listeners.
 */
export function bindAppendDraftQuery(input: InputHub, sessions: ISessions): () => void {
  const apply = (): void => {
    captureAppendDraftFromUrl()
    const sessionId = pendingSessionId as SessionId | undefined
    if (sessionId === undefined) return
    const loaded = input.draftLoaded(sessionId)
    if (loaded === undefined) return
    void loaded.then(() => { applyPendingAppendDraft(input, sessionId) })
  }
  apply()
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', apply)
    window.addEventListener('pageshow', apply)
  }
  const off = sessions.list.subscribe(apply)
  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', apply)
      window.removeEventListener('pageshow', apply)
    }
    off()
  }
}
