/** Chat-owned event-to-view projection. */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-api-remotes/client'
import {
  displayFailure, emptyAssistantBlock, toAssistantBlock, toAssistantBlocks,
  isTokenDelta,
} from '../src/client/conversation-nodes/event-projection.ts'

describe('toAssistantBlock', () => {
  it('classifies the four block shapes', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 1,
      height: 1,
    }
    const blocks: ContentBlock[] = [
      { type: 'text', text: '正文' },
      { type: 'reasoning', text: '思考' },
      { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' } as ContentBlock,
      { type: 'image', attachment },
    ]
    expect(toAssistantBlocks(blocks)).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'reasoning', text: '思考' },
      { kind: 'tool-call', callId: 'c1', name: 'echo', argsRaw: '{}' },
      { kind: 'image', attachment },
    ])
    expect(toAssistantBlock(blocks[0] as ContentBlock)).toEqual({ kind: 'text', text: '正文' })
    expect(toAssistantBlock({ type: 'future' } as unknown as ContentBlock))
      .toEqual({ kind: 'other', block: { type: 'future' } })
  })

  it('marks encrypted reasoning that has no summary and ignores everything else', () => {
    const encrypted = {
      type: 'reasoning',
      thinkingSignature: JSON.stringify({
        id: 'rs_1',
        type: 'reasoning',
        summary: [],
        content: [],
        encrypted_content: 'gAAAAA-secret-blob',
      }),
    }
    const summarized = {
      type: 'reasoning',
      thinkingSignature: JSON.stringify({
        id: 'rs_2',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'already shown' }],
        content: [],
        encrypted_content: 'gAAAAA-secret-blob',
      }),
    }
    const withReasoningText = {
      type: 'reasoning',
      thinkingSignature: JSON.stringify({
        id: 'rs_3',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'raw' }],
        encrypted_content: 'gAAAAA-secret-blob',
      }),
    }
    const opaque = {
      type: 'reasoning',
      thinkingSignature: JSON.stringify({
        id: 'rs_4',
        type: 'reasoning',
        summary: [],
        encrypted_content: 'o5/Pvqf-secret',
      }),
    }
    const content: ContentBlock[] = [
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: 'visible summary' },
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: '' },
    ]
    expect(toAssistantBlocks(content, [
      encrypted,
      { type: 'reasoning', thinkingSignature: 'not-json' },
      summarized,
      withReasoningText,
      opaque,
    ])).toEqual([
      { kind: 'reasoning', text: '', encrypted: true },
      { kind: 'reasoning', text: '' },
      { kind: 'reasoning', text: 'visible summary' },
      { kind: 'reasoning', text: '' },
      { kind: 'reasoning', text: '', opaque: true },
    ])
    expect(toAssistantBlocks([{ type: 'reasoning', text: '' }])).toEqual([
      { kind: 'reasoning', text: '' },
    ])
  })

  it('creates empty streamed block projections', () => {
    expect(emptyAssistantBlock('text')).toEqual({ kind: 'text', text: '' })
    expect(emptyAssistantBlock('reasoning')).toEqual({ kind: 'reasoning', text: '' })
    expect(emptyAssistantBlock('tool-call')).toEqual({ kind: 'tool-call', callId: '', name: '', argsRaw: '' })
    expect(emptyAssistantBlock('future')).toEqual({ kind: 'other', block: null })
  })

  it('redacts auth failures and presents the remaining durable values', () => {
    expect(displayFailure({ code: 'AUTH', message: 'secret' })).toEqual({ code: 'AUTH', message: '' })
    expect(displayFailure({ code: 'TRANSPORT', message: 'offline' }))
      .toEqual({ code: 'TRANSPORT', message: 'offline' })
    expect(displayFailure({ code: 'UNKNOWN' })).toEqual({ code: 'UNKNOWN', message: '{"code":"UNKNOWN"}' })
    expect(displayFailure(null)).toEqual({ message: 'null' })
  })

  it('recognizes only non-empty token deltas', () => {
    expect(isTokenDelta({ type: 'text-delta', index: 0, text: 'x' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'reasoning-delta', index: 0, text: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '', name: 'tool' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'finish', reason: 'stop' } as never)).toBe(false)
  })
})
