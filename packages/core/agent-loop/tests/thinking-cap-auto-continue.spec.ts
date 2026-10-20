import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, maxTokensResponse, reasoningMaxTokensResponse, textResponse } from './mock-adapter.ts'
import {
  THINKING_CAP_AUTO_CONTINUE_TEXT,
  applyThinkingCapAutoContinue,
  isThinkingCapStop,
  shouldFollowupThinkingCap,
  thinkingCapAutoContinueProjectionDefinition,
} from '../src/thinking-cap-auto-continue.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function enableAutoContinue(agent: Agent) {
  agent.session.append('session/thinking-cap-auto-continue', { enabled: true }, { ignorable: true })
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

function assistant(content: Parameters<typeof createAssistantMessage>[0]['content']) {
  return createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } })
}

function fold(events: readonly SessionEvent[]) {
  return events.reduce(applyThinkingCapAutoContinue, thinkingCapAutoContinueProjectionDefinition.init())
}

describe('thinking-cap auto-continue helpers', () => {
  it('reads the latest enabled flag and ignores earlier disables', () => {
    const session = Session.create(SessionId('flag'))
    expect(fold(session.snapshotEvents()).enabled).toBe(false)
    session.append('session/thinking-cap-auto-continue', { enabled: true }, { ignorable: true })
    session.append('session/thinking-cap-auto-continue', { enabled: false }, { ignorable: true })
    session.append('session/thinking-cap-auto-continue', { enabled: true }, { ignorable: true })
    expect(fold(session.snapshotEvents()).enabled).toBe(true)
  })

  it('treats reasoning-only content as a thinking-cap stop and rejects visible or tool output', () => {
    expect(isThinkingCapStop(assistant([{ type: 'reasoning', text: 'plan' }]))).toBe(true)
    expect(isThinkingCapStop(assistant([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: '   ' }]))).toBe(true)
    expect(isThinkingCapStop(assistant([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'hi' }]))).toBe(false)
    expect(isThinkingCapStop(assistant([{ type: 'text', text: 'hi' }]))).toBe(false)
    expect(isThinkingCapStop(assistant([{
      type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}',
    }]))).toBe(false)
  })

  it('counts consecutive prior auto-continues that followed max-tokens ends', () => {
    const session = Session.create(SessionId('streak'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: THINKING_CAP_AUTO_CONTINUE_TEXT }],
      source: { kind: 'thinking-cap-auto-continue' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: THINKING_CAP_AUTO_CONTINUE_TEXT }],
      source: { kind: 'thinking-cap-auto-continue' },
    }), { surfaceOp: 'append' })
    expect(fold(session.snapshotEvents()).consecutiveAutoContinues).toBe(2)
    const completed = Session.create(SessionId('not-max'))
    completed.append('turn/start', { turn: 1 })
    completed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fold(completed.snapshotEvents()).consecutiveAutoContinues).toBe(0)
    const ordinary = Session.create(SessionId('ordinary'))
    ordinary.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    ordinary.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(fold(ordinary.snapshotEvents()).consecutiveAutoContinues).toBe(0)
  })

  it('projects the latest enabled flag through the host fold', () => {
    const event = Session.create(SessionId('proj')).append(
      'session/thinking-cap-auto-continue',
      { enabled: true },
      { ignorable: true },
    )
    const enabled = applyThinkingCapAutoContinue(thinkingCapAutoContinueProjectionDefinition.init(), event)
    expect(enabled.enabled).toBe(true)
    expect(applyThinkingCapAutoContinue(enabled, event)).toBe(enabled)
    expect(applyThinkingCapAutoContinue(
      enabled,
      Session.create(SessionId('other')).append('turn/start', { turn: 1 }),
    )).toBe(enabled)
    expect(thinkingCapAutoContinueProjectionDefinition.wire.view(enabled)).toBe(true)
    const autoContinue = createUserMessage({
      content: [{ type: 'text', text: THINKING_CAP_AUTO_CONTINUE_TEXT }],
      source: { kind: 'thinking-cap-auto-continue' },
    })
    const session = Session.create(SessionId('no-pending'))
    session.append('user/message', autoContinue, { surfaceOp: 'append' })
    expect(fold(session.snapshotEvents()).consecutiveAutoContinues).toBe(0)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(fold(session.snapshotEvents()).consecutiveAutoContinues).toBe(0)
  })
})

describe('thinking-cap auto-continue loop', () => {
  it('does not auto-continue while the next-turn inbox already has work', async () => {
    const adapter = new MockAdapter([reasoningMaxTokensResponse('plan')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('queued'), { provider: 'mock', model: 'mock' })
    enableAutoContinue(agent)
    agent.inbox.splice('next-turn', 0, 0, [createUserMessage({
      content: [{ type: 'text', text: 'queued' }],
      source: { kind: 'user' },
    })])
    expect(shouldFollowupThinkingCap(agent)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('does not auto-continue a reasoning-only max-tokens stop while the flag is off', async () => {
    const adapter = new MockAdapter([reasoningMaxTokensResponse('plan')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('off'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(userTexts(agent)).toEqual(['go'])
    await ctx.fiber.dispose()
  })

  it('does not auto-continue a visible-text max-tokens stop even when the flag is on', async () => {
    const adapter = new MockAdapter([maxTokensResponse('hello'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('text'), { provider: 'mock', model: 'mock' })
    enableAutoContinue(agent)
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(userTexts(agent)).toEqual(['go'])
    await ctx.fiber.dispose()
  })

  it('auto-continues two reasoning-only max-tokens stops then leaves the third interrupt', async () => {
    const adapter = new MockAdapter([
      reasoningMaxTokensResponse('one'),
      reasoningMaxTokensResponse('two'),
      reasoningMaxTokensResponse('three'),
      textResponse('unused'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('cap'), { provider: 'mock', model: 'mock' })
    enableAutoContinue(agent)
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(3)
    expect(userTexts(agent)).toEqual(['go', THINKING_CAP_AUTO_CONTINUE_TEXT, THINKING_CAP_AUTO_CONTINUE_TEXT])
    const auto = agent.session.snapshotEvents().filter((event: SessionEvent) => (
      event.type === 'user/message' && event.data.source.kind === 'thinking-cap-auto-continue'
    ))
    expect(auto).toHaveLength(2)
    const reasons = agent.session.snapshotEvents()
      .filter(event => event.type === 'turn/end')
      .map(event => event.type === 'turn/end' ? event.data.reason : undefined)
    expect(reasons).toEqual([{ kind: 'max-tokens' }, { kind: 'max-tokens' }, { kind: 'max-tokens' }])
    await ctx.fiber.dispose()
  })

  it('contains a followup failure so the stopping turn still ends', async () => {
    const adapter = new MockAdapter([reasoningMaxTokensResponse('plan')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = await ctx.agentLoop.create(SessionId('fail'), { provider: 'mock', model: 'mock' })
    enableAutoContinue(agent)
    const originalFollowup = agent.followup.bind(agent)
    let followups = 0
    vi.spyOn(agent, 'followup').mockImplementation((message) => {
      followups++
      if (followups === 1) {
        originalFollowup(message)
        return
      }
      throw new Error('followup failed')
    })
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('thinking-cap auto-continue failed'))
    expect(adapter.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
