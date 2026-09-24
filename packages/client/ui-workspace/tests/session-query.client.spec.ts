import { describe, expect, it } from 'vitest'
import { parseSessionQuery, sessionIdFromSearch } from '../src/client/session-query.ts'

describe('sessionIdFromSearch', () => {
  it('reads a single session query', () => {
    expect(sessionIdFromSearch('?session=session-abc')).toBe('session-abc')
  })

  it('rejects missing, duplicate, or unsafe values', () => {
    expect(sessionIdFromSearch('')).toBeUndefined()
    expect(sessionIdFromSearch('?token=x')).toBeUndefined()
    expect(sessionIdFromSearch('?session=a&session=b')).toBeUndefined()
    expect(sessionIdFromSearch('?session=../etc/passwd')).toBeUndefined()
  })
})

describe('parseSessionQuery', () => {
  it('classifies absence, id, and malformed values', () => {
    expect(parseSessionQuery('')).toEqual({ kind: 'absent' })
    expect(parseSessionQuery('?session=session-abc')).toEqual({ kind: 'id', id: 'session-abc' })
    expect(parseSessionQuery('?session=a&session=b')).toEqual({ kind: 'malformed' })
    expect(parseSessionQuery('?session=../x')).toEqual({ kind: 'malformed' })
  })
})
