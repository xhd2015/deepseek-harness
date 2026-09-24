// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createConversationStore, hasConversationDraftChanges, readConversationViewPreference } from '../src/client/stores.ts'

const KEY = 'dsh.conversation'

beforeEach(() => {
  localStorage.clear()
})

describe('createConversationStore', () => {
  it('owns draft, selected View, and one-shot View requests', () => {
    const store = createConversationStore().create()
    expect(store.store.getSnapshot()).toEqual({ draft: '', draftDirty: false, view: null, viewRequest: null })

    store.actions.setDraft('hello')
    store.actions.setView('chat')
    expect(store.store.getSnapshot()).toEqual({
      draft: 'hello',
      draftDirty: true,
      view: 'chat',
      viewRequest: null,
    })

    store.actions.openView('trajectory', 'call-1')
    expect(store.store.getSnapshot()).toMatchObject({
      view: 'trajectory',
      viewRequest: { view: 'trajectory', focus: 'call-1' },
    })
    store.actions.completeViewRequest()
    expect(store.store.getSnapshot().viewRequest).toBeNull()
  })

  it('persists per Session scope and clears the persisted value', () => {
    const first = createConversationStore().create('sess-1')
    first.actions.setDraft('draft for one')
    first.actions.setView('chat')
    expect(localStorage.getItem(`${KEY}.sess-1`)).not.toBeNull()
    expect(localStorage.getItem(`${KEY}.sess-2`)).toBeNull()

    const restored = createConversationStore().create('sess-1')
    expect(restored.store.getSnapshot()).toMatchObject({
      draft: 'draft for one',
      view: 'chat',
    })

    first.clearPersisted()
    expect(localStorage.getItem(`${KEY}.sess-1`)).toBeNull()
  })

  it('creates independent live instances', () => {
    const handle = createConversationStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.setDraft('only first')
    expect(second.store.getSnapshot().draft).toBe('')
  })

  it('distinguishes an explicitly cleared draft from absent browser recovery', () => {
    const id = 'draft-presence' as SessionId
    expect(hasConversationDraftChanges(id)).toBe(false)
    const store = createConversationStore().create(id)
    store.actions.setDraft('task')
    store.actions.setDraft('')
    expect(hasConversationDraftChanges(id)).toBe(true)
    store.actions.markDraftSaved('task')
    expect(hasConversationDraftChanges(id)).toBe(true)
    store.actions.markDraftSaved('')
    expect(hasConversationDraftChanges(id)).toBe(false)
    localStorage.setItem(`${KEY}.${id}`, '{"draft":"legacy local draft"}')
    expect(hasConversationDraftChanges(id)).toBe(true)
    for (const raw of ['null', '[]', '4', '{}', '{"draft":4}', '{invalid']) {
      localStorage.setItem(`${KEY}.${id}`, raw)
      expect(hasConversationDraftChanges(id)).toBe(false)
    }
  })

  it('reads only a usable persisted View preference', () => {
    const sessionId = 'sess-1' as SessionId
    const store = createConversationStore().create(sessionId)
    store.actions.setView('trajectory')
    expect(readConversationViewPreference(sessionId)).toBe('trajectory')

    localStorage.setItem(`${KEY}.${sessionId}`, '{invalid')
    expect(readConversationViewPreference(sessionId)).toBeNull()
  })
})
