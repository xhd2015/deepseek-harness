// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { captureAppendDraftFromUrl, consumeAppendDraft, joinDraft, peekAppendDraft } from '../src/client/input/append-draft-query.ts'

describe('appendDraft query', () => {
  it('reads a single appendDraft value', () => {
    expect(peekAppendDraft('?session=session-abc&appendDraft=%2Fbrainstorm%20hello')).toBe('/brainstorm hello')
    expect(peekAppendDraft('?session=session-abc')).toBeUndefined()
    expect(peekAppendDraft('?appendDraft=a&appendDraft=b')).toBeUndefined()
  })

  it('joins onto an existing draft with a newline', () => {
    expect(joinDraft('', '/brainstorm one')).toBe('/brainstorm one')
    expect(joinDraft('  ', '/brainstorm one')).toBe('/brainstorm one')
    expect(joinDraft('keep this\n', '/brainstorm two')).toBe('keep this\n/brainstorm two')
  })

  it('strips appendDraft from the page URL', () => {
    const previous = window.location.href
    window.history.replaceState(null, '', '/?session=session-abc&appendDraft=%2Fbrainstorm%20hello&token=t')
    expect(consumeAppendDraft()).toBe('/brainstorm hello')
    expect(window.location.search).toBe('?session=session-abc&token=t')
    expect(consumeAppendDraft()).toBeUndefined()
    window.history.replaceState(null, '', previous)
  })

  it('keeps a captured payload after the query is stripped', () => {
    const previous = window.location.href
    window.history.replaceState(null, '', '/?session=session-abc&appendDraft=test%20draft')
    captureAppendDraftFromUrl()
    expect(window.location.search).toBe('?session=session-abc')
    window.history.replaceState(null, '', previous)
  })
})
