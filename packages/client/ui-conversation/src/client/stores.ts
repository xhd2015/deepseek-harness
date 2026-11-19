/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationStoreState } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  markDraftSaved: (draft: ConversationStoreState, text: string) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', draftDirty: false, view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text; d.draftDirty = true },
      markDraftSaved: (d, text: string) => {
        const current = typeof d.draft === 'string' ? d.draft : d.draft.text
        if (current === text) d.draftDirty = false
      },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  const empty: DraftSnapshot = { text: '', references: [] }
  if (typeof localStorage === 'undefined') return empty
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return empty
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return empty
    return parseStoredDraft(stored.draft) ?? empty
  } catch (_error: unknown) {
    // Unavailable browser storage or malformed JSON has no usable saved draft.
    return empty
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  const stored = readStoredConversation(sessionId)
  return stored !== undefined && typeof stored.view === 'string' ? stored.view : null
}

/**
 * Distinguish unsaved browser recovery text from an acknowledged Host mirror.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns whether recovery includes unsaved text or a clear; older records count as unsaved.
 */
export function hasConversationDraftChanges(sessionId: SessionId): boolean {
  const stored = readStoredConversation(sessionId)
  const draft = stored?.draft
  const text = typeof draft === 'string'
    ? draft
    : typeof draft === 'object' && draft !== null && 'text' in draft && typeof draft.text === 'string'
      ? draft.text
      : undefined
  return text !== undefined && stored?.draftDirty !== false
}

function readStoredConversation(sessionId: SessionId): Record<string, unknown> | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return undefined
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
    return stored as Record<string, unknown>
  } catch (_error) {
    // Unavailable or malformed browser storage has no recoverable value.
    return undefined
  }
}
