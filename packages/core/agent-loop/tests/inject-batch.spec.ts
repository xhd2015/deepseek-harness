import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

async function freshAgent(adapter: MockAdapter): Promise<Agent> {
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
  return ctx.agentLoop.create(brandString<SessionId>('a1'), { provider: 'mock', model: 'mock' })
}

/** Event types this session recorded, in order. */
function types(agent: Agent): string[] {
  return agent.session.snapshotEvents().map(event => event.type)
}

/** Assistant messages the session recorded, in order. */
function assistantMessages(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event =>
    event.type === 'assistant/message' ? [event.data.message] : [])
}

describe('injectBatch', () => {
  it('commits the whole batch in one contiguous seq run, in authored order', async () => {
    const subject = await freshAgent(new MockAdapter([textResponse('ok')]))

    const result = subject.injectBatch!([
      { kind: 'user', text: 'question' },
      { kind: 'thinking', text: 'considering' },
      { kind: 'assistant', text: 'answer' },
    ])

    // Three events, no gap, authored order — the batch is one append.
    const seqs = result.seqs.map(seq => Number(seq))
    expect(seqs).toHaveLength(3)
    // Contiguous and still monotonic against the log the batch joined.
    expect(seqs[1]).toBe(seqs[0]! + 1)
    expect(seqs[2]).toBe(seqs[1]! + 1)
    expect(types(subject).filter(type => type === 'user/message')).toHaveLength(1)
    // The batch is the session's first three events; the turn it woke opens after them.
    expect(types(subject).slice(0, 3)).toEqual(['user/message', 'assistant/message', 'assistant/message'])
    await subject.whenIdle()
  })

  it('writes thinking as a reasoning block and assistant as text', async () => {
    const subject = await freshAgent(new MockAdapter([textResponse('ok')]))
    // A batch of only assistant-role events keeps the log untouched by a turn.
    subject.injectBatch!([
      { kind: 'thinking', text: 'reason here' },
      { kind: 'assistant', text: 'speech here' },
    ])
    const messages = assistantMessages(subject).slice(0, 2)

    expect(messages[0]?.content).toEqual([{ type: 'reasoning', text: 'reason here' }])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'speech here' }])
    // The surface validator requires a model source with a provider/model route.
    expect(messages[0]?.source).toMatchObject({ kind: 'model', provider: 'mock', model: 'mock' })
    await subject.whenIdle()
  })

  it('rejects an empty batch and a blank entry without touching the log', async () => {
    const subject = await freshAgent(new MockAdapter([textResponse('ok')]))
    const before = subject.session.seq

    expect(() => subject.injectBatch!([])).toThrow(/empty/)
    expect(() => subject.injectBatch!([
      { kind: 'user', text: 'fine' },
      { kind: 'assistant', text: '   ' },
    ])).toThrow(/no text/)

    // All-or-nothing: the valid neighbour of the blank entry did not land either.
    expect(subject.session.seq).toBe(before)
    await subject.whenIdle()
  })

  it('runs once on its own when the agent is idle', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const subject = await freshAgent(adapter)

    const result = subject.injectBatch!([
      { kind: 'user', text: 'question' },
      { kind: 'thinking', text: 'considering' },
    ])
    expect(result.started).toBe(true)
    await subject.whenIdle()

    // The turn opened without a follow-up prompt, and the batch is history.
    expect(adapter.requests).toHaveLength(1)
    expect(types(subject)).toContain('turn/start')
    const sent = adapter.requests[0]?.messages ?? []
    expect(sent.some(message => message.role === 'user')).toBe(true)
    expect(sent.some(message => message.role === 'assistant')).toBe(true)
  })

  it('runs even when the batch carries no user message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const subject = await freshAgent(adapter)

    subject.injectBatch!([
      { kind: 'thinking', text: 'only a thought' },
      { kind: 'assistant', text: 'only a statement' },
    ])
    await subject.whenIdle()

    // Injected work is its own wake reason; it does not need a user prompt.
    expect(adapter.requests).toHaveLength(1)
  })

  it('takes one more step inside the open turn instead of starting a new one', async () => {
    const holder: { agent?: Agent } = {}
    const adapter = new MockAdapter([
      (): ReturnType<typeof textResponse> => {
        // Inject while this step is streaming: the agent is mid-turn here.
        holder.agent?.injectBatch!([{ kind: 'assistant', text: 'interjected' }])
        return textResponse('first step')
      },
      textResponse('second step'),
    ])
    const subject = await freshAgent(adapter)
    holder.agent = subject

    subject.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await subject.whenIdle()

    // One turn, two steps: the injected batch bought the second step.
    expect(types(subject).filter(type => type === 'turn/start')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
    const secondStep = adapter.requests[1]?.messages ?? []
    expect(secondStep.some(message => message.role === 'assistant'
      && message.content.some(block => block.type === 'text' && block.text === 'interjected'))).toBe(true)
  })
})
