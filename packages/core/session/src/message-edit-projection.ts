/**
 * Rewrite or remove existing model-visible messages without changing their identity.
 *
 * The edit is a durable event interpreted by a pure projection, so it replays
 * identically from the log and reaches the next model request without touching
 * the events it edits.
 *
 * @module @deepseek-ai/dsh-session-edit-projection
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { MessageEdit, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection, SessionMessageProjectionContext } from '@deepseek-ai/dsh-session/surface'

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable value is a canonical event sequence. */
function isEventSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

/**
 * Read one committed edit, rejecting a record that names neither or both forms.
 * @param value - one entry of the durable `edits` array.
 * @returns the validated edit.
 * @throws when the entry is not exactly a text edit or a removal.
 */
function readEdit(value: unknown): MessageEdit {
  if (!isRecord(value) || !isEventSeq(value['seq'])) {
    throw new Error('message/edit: each edit needs a seq')
  }
  const keys = Object.keys(value)
  const deleted = value['deleted']
  if (deleted === true) {
    if (keys.length !== 2) throw new Error(`message/edit: removal of seq ${value['seq']} carries extra fields`)
    return { seq: value['seq'], deleted: true }
  }
  if (deleted !== undefined) {
    throw new Error(`message/edit: "deleted" on seq ${value['seq']} must be true when present`)
  }
  const text = value['text']
  if (typeof text !== 'string') throw new Error(`message/edit: seq ${value['seq']} needs a text string`)
  if (keys.length !== 2) throw new Error(`message/edit: edit of seq ${value['seq']} carries extra fields`)
  return { seq: value['seq'], text }
}

/**
 * Replace a message's model-facing blocks with one text block.
 *
 * A tool result keeps its `toolCallId` and `isError`: those are what pair it with
 * its call, and an edit that dropped them would leave a result answering nothing.
 * @param message - the current message.
 * @param text - replacement text.
 * @returns an immutable copy carrying the new content.
 */
function withText(message: Message, text: string): Message {
  const block: ContentBlock = { type: 'text', text }
  return { ...message, content: [block] }
}

/**
 * Read a surface node's committed message payload.
 * @param context - projection context carrying the committed event window.
 * @param seq - surface node to read.
 * @returns the message the event carries, or undefined when it carries none.
 * @throws when a surface node names an event type that produces no message.
 */
function sourceMessage(context: SessionMessageProjectionContext, seq: SessionSeq): Message | undefined {
  const event = context.events[seq - context.baseSeq]
  if (event === undefined) return undefined
  switch (event.type) {
    case 'user/message':
    case 'system/message':
    case 'developer/message':
      return event.data as Message
    case 'assistant/message':
    case 'tool/result':
      return (event.data as { message: Message }).message
    default:
      throw new Error(`message/edit: seq ${seq} is "${event.type}", which carries no message`)
  }
}

/**
 * Interpret one `message/edit` decision.
 *
 * A target that is no longer a current node is skipped instead of refused: the
 * edit was valid when written, and a later compaction shadowing its target must
 * not turn committed history into a log that fails to load.
 */
export const messageEditProjection: SessionMessageProjection<'message/edit'> = {
  type: 'message/edit',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data['edits']) || data['edits'].length === 0) {
      throw new Error('message/edit: data must contain a nonempty edits array')
    }
    const edits = data['edits'].map(readEdit)
    const current = new Set(context.nodes)
    const messages = new Map<SessionSeq, Message | null>()
    for (const edit of edits) {
      if (messages.has(edit.seq)) throw new Error(`message/edit: duplicate target seq ${edit.seq}`)
      if (!current.has(edit.seq)) continue
      if ('deleted' in edit) {
        // `null` removes the message from model history. The surface node keeps
        // its seq, so every other message's identity is untouched and a client
        // keyed by seq still matches the rows it already holds.
        messages.set(edit.seq, null)
        continue
      }
      // A projected copy wins; otherwise the message is the committed event's own
      // payload. `context.messages` holds only already-projected messages, so a
      // first-time edit must read the source event.
      const message = context.messages.get(edit.seq) ?? sourceMessage(context, edit.seq)
      if (message === undefined) {
        throw new Error(`message/edit: seq ${edit.seq} is a current node with no message`)
      }
      messages.set(edit.seq, withText(message, edit.text))
    }
    return messages
  },
}
