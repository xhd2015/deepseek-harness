/**
 * Materialization of a compacted Session surface into the seed log of a new
 * Session. A compaction replaces an old range with a summary `user/message` and
 * keeps the recent tail, so the surface is the context the source would send
 * next; copying the log prefix (a fork) would keep the old events instead.
 * @module @deepseek-ai/dsh-session-controller/compacted-seed
 */

import { randomUUID } from 'node:crypto'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, SystemMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

type SeedInput = Omit<SessionEvent, 'seq' | 'time'>

/** Retention policy for the seed: the last turn stays whole, older turns shrink. */
export interface CompactedSeedOptions {
  /** Whole turns kept, including the last; older turns are dropped. Default 10. */
  readonly retainTurns?: number
  /** Per-result cap in the last turn; larger text is truncated head/tail. Default 64 KiB. */
  readonly maxToolResultBytes?: number
}

interface TurnNode {
  readonly kind: 'user' | 'assistant' | 'tool'
  readonly event: SessionEvent
}

interface Turn {
  readonly nodes: TurnNode[]
  toolResults: number
}

function groupTurns(events: readonly SessionEvent[], surface: readonly SessionSeq[]): Turn[] {
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) bySeq.set(event.seq, event)
  const turns: Turn[] = []
  for (const seq of surface) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    switch (event.type) {
      case 'user/message': {
        const kind = (event.data.source as { kind?: string }).kind
        // Runtime context (time, environment) is not a conversation turn, and a
        // compaction checkpoint is the summary itself, not a user question.
        if (kind !== 'user' && kind !== 'compact-checkpoint') continue
        turns.push({ nodes: [{ kind: 'user', event }], toolResults: 0 })
        continue
      }
      case 'assistant/message': {
        if (turns.length === 0) turns.push({ nodes: [], toolResults: 0 })
        const tail = turns[turns.length - 1]
        if (tail !== undefined) tail.nodes.push({ kind: 'assistant', event })
        continue
      }
      case 'tool/result': {
        if (turns.length === 0) turns.push({ nodes: [], toolResults: 0 })
        const tail = turns[turns.length - 1]
        if (tail !== undefined) {
          tail.nodes.push({ kind: 'tool', event })
          tail.toolResults += 1
        }
        continue
      }
      default:
        continue
    }
  }
  return turns
}

/** Replace oversized text blocks with a head/tail excerpt. */
function truncateResult(message: { content: readonly unknown[] }, maxBytes: number): { content: unknown[]; changed: boolean } {
  const encoded = JSON.stringify(message.content)
  if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) return { content: message.content as unknown[], changed: false }
  const half = Math.max(1, Math.floor(maxBytes / 2))
  return {
    changed: true,
    content: [{
      type: 'text',
      text: `${encoded.slice(0, half)}\n… [omitted ${encoded.length - maxBytes} chars] …\n${encoded.slice(-half)}`,
    }],
  }
}

/**
 * Rebuild one valid Session log from a post-compaction surface.
 * @param events - source log the surface seqs point into.
 * @param surface - surface node seqs in head-to-tail order.
 * @param options - retention policy; the last turn stays whole, older kept turns
 *   keep their user message (with an omission note) and their final assistant
 *   message, and turns beyond the window are dropped.
 * @returns seed events with contiguous seqs from zero, closed by an `end-seed` cut marker.
 */
export function buildCompactedSeed(
  events: readonly SessionEvent[],
  surface: readonly SessionSeq[],
  options: CompactedSeedOptions = {},
): SessionEvent[] {
  const retainTurns = Math.max(1, options.retainTurns ?? 10)
  const maxToolResultBytes = Math.max(1024, options.maxToolResultBytes ?? 64 * 1024)
  const all = groupTurns(events, surface)
  const checkpoint = all.findLast(
    turn => (turn.nodes[0]?.event.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'compact-checkpoint',
  )
  const recent = all.slice(-(retainTurns + 1)).filter(turn => turn !== checkpoint)
  const turns = checkpoint === undefined ? recent : [checkpoint, ...recent]

  const seed: SessionEvent[] = []
  let time = 0
  const add = (event: SeedInput, at?: number): SessionSeq => {
    const seq = brandNumber<SessionSeq>(seed.length)
    seed.push({ ...event, seq, time: at ?? time } as SessionEvent)
    return seq
  }
  let turn = 0
  const emitTurn = (source: Turn, whole: boolean): void => {
    turn += 1
    step = 1
    const lastAssistant = source.nodes.findLast(node => node.kind === 'assistant')
    const nodes = whole ? source.nodes : source.nodes.filter(node => node.kind === 'user' || node === lastAssistant)
    if (nodes.length === 0) { turn -= 1; return }
    add({ type: 'turn/start', data: { turn } })
    add({ type: 'step/start', data: { turn, step } })
    if (turn === 1) {
      const head: SystemMessage = {
        id: brandString<MessageId>(randomUUID()),
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      }
      add({ type: 'system/message', data: { turn, step, message: head }, surfaceOp: 'append' })
    }
    let assistantSeen = false
    for (const node of nodes) {
      time = Math.max(time, node.event.time)
      if (node.kind === 'user') {
        const message = (node.event as Extract<SessionEvent, { type: 'user/message' }>).data
        const content = whole
          ? message.content
          : [...message.content, { type: 'text' as const, text: `[omitted ${source.toolResults} tool calls]` }]
        add({ type: 'user/message', data: { ...message, content }, surfaceOp: 'append' })
        continue
      }
      if (node.kind === 'assistant') {
        if (assistantSeen) {
          add({ type: 'step/end', data: { turn, step } })
          step += 1
          add({ type: 'step/start', data: { turn, step } })
        }
        assistantSeen = true
        const assistantEvent = node.event as Extract<SessionEvent, { type: 'assistant/message' }>
        add({
          type: 'assistant/message',
          data: { turn, step, message: assistantEvent.data.message, stream: assistantEvent.data.stream },
          surfaceOp: 'append',
        }, node.event.time)
        for (const block of assistantEvent.data.message.content) {
          if (block.type !== 'tool-call') continue
          add({ type: 'tool/call', data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments } }, node.event.time)
        }
        continue
      }
      const resultEvent = node.event as Extract<SessionEvent, { type: 'tool/result' }>
      const truncated = truncateResult(resultEvent.data.message, maxToolResultBytes)
      add({
        type: 'tool/result',
        data: {
          turn,
          step,
          message: { ...resultEvent.data.message, ...(truncated.changed ? { content: truncated.content as never } : {}) },
        },
        surfaceOp: 'append',
      }, node.event.time)
    }
    add({ type: 'step/end', data: { turn, step } })
    add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  let step = 1
  for (const [index, source] of turns.entries()) {
    emitTurn(source, source === checkpoint || index === turns.length - 1)
  }
  // Mark the cut: these events are inherited history, not this Session's own turns.
  add({ type: 'session/end-seed', data: { inherited: true } })
  return seed
}
