/**
 * Pause / Continue: a live turn is suspended without ending the Session, and
 * Continue calls the model again with the same model-visible history — no user
 * message is inserted, and the partial stream never reaches the surface.
 * @module dsh-agent-loop/tests/pause
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('Agent.pause()', () => {
  it('suspends the live turn, discards the partial stream, and continues with the same history', async () => {
    const adapter = new MockAdapter([
      { hangAfter: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial answer' },
      ] },
      textResponse('finished after continue'),
    ])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(brandString<SessionId>('pause-resume'), { provider: 'mock', model: 'mock' })
      const requested = new Promise<void>((resolve) => {
        ctx.on('agent/request', ({ turn }, next) => {
          if (turn === 1) resolve()
          return next()
        })
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
      await requested
      // Pause after the adapter has streamed its scripted prefix: the point is a
      // stream that already produced part of an answer, which must not surface.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(agent.pause()).toBe(true)
      await waitForIdle(ctx, agent)

      const firstIdle = agent.session.snapshotEvents()
      const endings = firstIdle.filter(event => event.type === 'turn/end')
      expect(endings).toHaveLength(1)
      const reason = endings[0]!.type === 'turn/end' ? endings[0]!.data.reason : undefined
      expect(reason).toMatchObject({ kind: 'aborted', reason: { kind: 'hook', reason: 'paused' } })
      // The partial stream is an attempt, not a model-visible message.
      expect(firstIdle.some(event => event.type === 'assistant/message')).toBe(false)
      expect(firstIdle.some(event => event.type === 'assistant/attempt')).toBe(true)

      expect(agent.resumePaused()).toBe(true)
      await waitForIdle(ctx, agent)

      expect(adapter.requests).toHaveLength(2)
      const [before, after] = adapter.requests
      expect(after!.messages).toEqual(before!.messages)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
      // Continue inserts no input of its own: one user message for the whole test.
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
