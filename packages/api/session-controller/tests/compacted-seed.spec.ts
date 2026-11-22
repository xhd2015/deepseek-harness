import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildCompactedSeed } from '../src/compacted-seed.ts'

type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>

function event<T extends SessionEvent['type']>(type: T, seq: number, data: EventOf<T>['data']): SessionEvent {
  return { type, seq: seq as SessionSeq, time: seq * 10, data } as EventOf<T>
}
const user = (id: string, text: string, kind = 'user') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind } })
const assistant = (id: string, text: string) => ({ id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } })
const result = (id: string, text: string) => ({ id, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', toolCallId: 'c1' }, toolCallId: 'c1' })

// checkpoint + 12 turns; each turn has a user question, an answer and a tool result.
function twelveTurns(): { events: SessionEvent[]; surface: SessionSeq[] } {
  const events: SessionEvent[] = []
  let seq = 0
  events.push(event('user/message', seq++, user('cp', 'SUMMARY OF OLDER WORK', 'compact-checkpoint')))
  for (let turn = 1; turn <= 12; turn += 1) {
    events.push(event('user/message', seq++, user(`u${turn}`, `question ${turn}`)))
    events.push(event('assistant/message', seq++, { turn, step: 1, message: assistant(`a${turn}`, `answer ${turn}`) as never, stream: [] }))
    events.push(event('tool/result', seq++, { turn, step: 1, message: result(`r${turn}`, `result ${turn}`) as never }))
  }
  return { events, surface: events.map((_, index) => index) as SessionSeq[] }
}

describe('buildCompactedSeed', () => {
  it('keeps the checkpoint, the last turn whole, and ten reduced turns', () => {
    const { events, surface } = twelveTurns()
    const seed = buildCompactedSeed(events, surface, { retainTurns: 10 })
    const users = seed.filter(e => e.type === 'user/message')
    // checkpoint + last 11 turns; turns 1 is dropped.
    expect(users).toHaveLength(12)
    expect(users[0].type === 'user/message' ? users[0].data.content[0] : undefined).toMatchObject({ text: 'SUMMARY OF OLDER WORK' })
    const texts = seed.filter(e => e.type === 'user/message').map(e => e.type === 'user/message' ? (e.data.content[0] as { text: string }).text : '')
    expect(texts).not.toContain('question 1')
    expect(texts).toContain('question 2')
    // The last turn keeps its tool result; earlier kept turns carry the omission note.
    const toolResults = seed.filter(e => e.type === 'tool/result')
    expect(toolResults).toHaveLength(1)
    expect(JSON.stringify(toolResults[0])).toContain('result 12')
    expect(JSON.stringify(seed)).toContain('[omitted 1 tool calls]')
    // The prior turn keeps its final assistant answer, and no tool result.
    expect(JSON.stringify(seed)).toContain('"text":"answer 2"')
    expect(JSON.stringify(seed)).not.toContain('"text":"result 2"')
    expect(seed.at(-1)?.type).toBe('session/end-seed')
  })

  it('drops runtime context and every turn beyond the window', () => {
    const events: SessionEvent[] = [
      event('user/message', 0, user('u1', 'question 1')),
      event('assistant/message', 1, { turn: 1, step: 1, message: assistant('a1', 'answer 1') as never, stream: [] }),
      event('user/message', 2, user('ctx', 'Time sampled while preparing turn 268', 'time-context')),
    ]
    const surface = [0, 1, 2] as SessionSeq[]
    const seed = buildCompactedSeed(events, surface, { retainTurns: 10 })
    expect(seed.filter(e => e.type === 'user/message')).toHaveLength(1)
    expect(JSON.stringify(seed)).not.toContain('Time sampled')
    expect(seed.at(-1)?.type).toBe('session/end-seed')
  })

  it('puts an empty system head at node 0 and no old system text', () => {
    const { events, surface } = twelveTurns()
    const seed = buildCompactedSeed(events, surface, { retainTurns: 10 })
    const head = seed.find(e => e.type === 'system/message')
    expect(head && head.type === 'system/message' ? head.data.message.content : undefined).toEqual([])
  })

  it('truncates an oversized last-turn tool result', () => {
    const { events, surface } = twelveTurns()
    const last = events.at(-2)!
    events[events.length - 2] = event('tool/result', Number(last.seq), {
      turn: 12, step: 1, message: result('r12', 'x'.repeat(5000)) as never,
    })
    const seed = buildCompactedSeed(events, surface, { retainTurns: 10, maxToolResultBytes: 1024 })
    expect(JSON.stringify(seed)).toContain('[omitted')
  })
})
