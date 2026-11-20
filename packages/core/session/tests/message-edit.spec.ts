import { describe, expect, it } from 'vitest'
import {
  SESSION_FORMAT_VERSION,
  Session,
  messageEditProjection,
  type SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Build a session with one user message and one assistant reply. */
function seeded(): { session: Session; userSeq: SessionSeq; assistantSeq: SessionSeq } {
  const session = Session.create(brandString<SessionId>('session-edit-test'), [], undefined, undefined, [messageEditProjection])
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'original question' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'original answer' }],
      source: { provider: 'test', model: 'test-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  return { session, userSeq: user.seq, assistantSeq: assistant.seq }
}

/** Derive the model-visible text of each message, in order. */
function texts(session: Session): string[] {
  return session.deriveMessages().map(message => message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(''))
}

describe('message/edit', () => {
  it('rewrites content and keeps the message seq', () => {
    const { session, assistantSeq } = seeded()
    session.append('message/edit', {
      edits: [{ seq: assistantSeq, text: 'rewritten answer' }],
    })
    expect(texts(session)).toEqual(['original question', 'rewritten answer'])
    // The edited node is still the same surface seq: a client keyed by seq keeps working.
    expect(session.surface.nodes).toContain(assistantSeq)
  })

  it('removes a message from the surface while leaving the others in place', () => {
    const { session, userSeq, assistantSeq } = seeded()
    session.append('message/edit', {
      edits: [{ seq: assistantSeq, deleted: true }],
    })
    expect(texts(session)).toEqual(['original question'])
    // The node keeps its seq so no other identity moves; it simply derives no
    // message any more.
    expect(session.surface.nodes).toEqual([userSeq, assistantSeq])
    // The durable event is still on the log; only the model-visible history dropped it.
    expect(session.eventAt(assistantSeq)?.type).toBe('assistant/message')
  })

  it('applies one batch as a transaction', () => {
    const { session, userSeq, assistantSeq } = seeded()
    session.append('message/edit', {
      edits: [
        { seq: userSeq, text: 'edited question' },
        { seq: assistantSeq, deleted: true },
      ],
    })
    expect(texts(session)).toEqual(['edited question'])
  })

  it('lets a later edit win over an earlier one on the same seq', () => {
    const { session, assistantSeq } = seeded()
    session.append('message/edit', { edits: [{ seq: assistantSeq, text: 'first' }] })
    session.append('message/edit', { edits: [{ seq: assistantSeq, text: 'second' }] })
    expect(texts(session)).toEqual(['original question', 'second'])
  })

  it('skips a target that is not a current surface node', () => {
    const { session } = seeded()
    // A log-only seq (here a turn boundary) is not a surface node. An edit that
    // names one is skipped, not refused: a compaction can shadow a node that an
    // earlier edit still names, and refusing would make the log unloadable.
    const boundary = session.append('turn/start', { turn: 2 })
    expect(() => session.append('message/edit', { edits: [{ seq: boundary.seq, text: 'ignored' }] })).not.toThrow()
    expect(texts(session)).toEqual(['original question', 'original answer'])
  })

  it('refuses an empty edit list and a duplicate target', () => {
    const { session, assistantSeq } = seeded()
    expect(() => session.append('message/edit', { edits: [] })).toThrow(/nonempty/)
    expect(() => session.append('message/edit', {
      edits: [{ seq: assistantSeq, text: 'a' }, { seq: assistantSeq, text: 'b' }],
    })).toThrow(/duplicate/)
  })

  it('replays from the log to the same history', () => {
    const { session, assistantSeq } = seeded()
    session.append('message/edit', { edits: [{ seq: assistantSeq, text: 'rewritten' }] })
    // The projection is pure, so folding the committed log again must reproduce
    // both the history and the node list.
    const folded = foldSurface(session.ownEvents(), [messageEditProjection])
    const replayed = folded.nodes
      .map(seq => deriveEventMessage(session.ownEvents()[seq]!, folded.projectedMessages))
      .filter((message): message is NonNullable<typeof message> => message !== null)
      .map(message => message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join(''))
    expect(replayed).toEqual(texts(session))
    expect(folded.nodes).toEqual([...session.surface.nodes])
  })

  it('keeps the format version readable with an edit in the log', () => {
    const { session, assistantSeq } = seeded()
    session.append('message/edit', { edits: [{ seq: assistantSeq, text: 'x' }] })
    expect(session.header.version).toBe(SESSION_FORMAT_VERSION)
  })
})
