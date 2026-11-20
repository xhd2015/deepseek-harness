import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type InjectedMessage } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** A real composed agent. The loop is never driven past the commit. */
async function createAgent(): Promise<Agent> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  return ctx.agentLoop.create(brandString<SessionId>('inject-tools'), { provider: 'mock', model: 'mock' })
}

describe('injectBatch tool entries', () => {
  it('commits a call and its result, and reports both seq runs', async () => {
    const agent = await createAgent()
    const head = Number(agent.session.seq)
    const result = agent.injectBatch([
      { kind: 'tool-call', tool: 'bash', arguments: '{"command":"pwd"}' },
      // The call above will occupy `head`; a result may name it before commit.
      { kind: 'tool-result', call: head as never, text: '/tmp/project' },
    ])

    // The call is log-only and the result is a surface node, so the two runs
    // differ even though the batch has two entries.
    expect(result.callSeqs).toHaveLength(1)
    expect(result.resultSeqs).toHaveLength(1)
    expect(result.seqs).toEqual([...result.callSeqs, ...result.resultSeqs])
    expect(result.started).toBe(true)

    const call = agent.session.eventAt(result.callSeqs[0]!)
    expect(call?.type).toBe('tool/call')
    if (call?.type !== 'tool/call') throw new Error('expected a tool call')
    expect(call.data.name).toBe('bash')
    expect(call.data.arguments).toBe('{"command":"pwd"}')

    const resultEvent = agent.session.eventAt(result.resultSeqs[0]!)
    if (resultEvent?.type !== 'tool/result') throw new Error('expected a tool result')
    // The result answers the call by its stamped id, so the provider pairs them.
    expect(resultEvent.data.message.toolCallId).toBe(call.data.callId)
    expect(resultEvent.data.message.isError).toBe(false)

    // Only the result is model-visible; the call is model-visible through it.
    expect(agent.session.surface.nodes).toContain(result.resultSeqs[0])
    expect(agent.session.surface.nodes).not.toContain(result.callSeqs[0])
  })

  it('answers a committed call from an earlier request', async () => {
    const agent = await createAgent()
    const first = agent.injectBatch([{ kind: 'tool-call', tool: 'read', arguments: '{"path":"a.txt"}' }])
    const second = agent.injectBatch([
      { kind: 'tool-result', call: first.callSeqs[0]!, text: 'file body' },
    ])
    const call = agent.session.eventAt(first.callSeqs[0]!)
    const result = agent.session.eventAt(second.resultSeqs[0]!)
    if (call?.type !== 'tool/call' || result?.type !== 'tool/result') throw new Error('unexpected events')
    expect(result.data.message.toolCallId).toBe(call.data.callId)
  })

  it('marks a failed result', async () => {
    const agent = await createAgent()
    const head = Number(agent.session.seq)
    const result = agent.injectBatch([
      { kind: 'tool-call', tool: 'bash', arguments: '{}' },
      { kind: 'tool-result', call: head as never, text: 'exit code 1', isError: true },
    ])
    const event = agent.session.eventAt(result.resultSeqs[0]!)
    if (event?.type !== 'tool/result') throw new Error('expected a tool result')
    expect(event.data.message.isError).toBe(true)
  })

  it('refuses a result that answers no call, before committing anything', async () => {
    const agent = await createAgent()
    const before = agent.session.seq
    expect(() => agent.injectBatch([
      { kind: 'tool-result', call: 999 as never, text: 'orphan' },
    ])).toThrow(/not a tool call/)
    // Nothing was written: a rejected batch leaves no residue.
    expect(agent.session.seq).toBe(before)
  })

  it('refuses a result whose target is a non-call event', async () => {
    const agent = await createAgent()
    const user = agent.injectBatch([{ kind: 'user', text: 'hello' }])
    expect(() => agent.injectBatch([
      { kind: 'tool-result', call: user.seqs[0]!, text: 'not a call' },
    ])).toThrow(/not a tool call/)
  })

  it('refuses a call with no tool name or no arguments', async () => {
    const agent = await createAgent()
    expect(() => agent.injectBatch([{ kind: 'tool-call', tool: '  ', arguments: '{}' }])).toThrow(/no tool name/)
    expect(() => agent.injectBatch([{ kind: 'tool-call', tool: 'bash', arguments: ' ' }])).toThrow(/no arguments/)
  })

  it('keeps text entries working alongside tool entries', async () => {
    const agent = await createAgent()
    const head = Number(agent.session.seq)
    const entries: readonly InjectedMessage[] = [
      { kind: 'user', text: 'check the directory' },
      { kind: 'thinking', text: 'I should list it' },
      { kind: 'tool-call', tool: 'bash', arguments: '{"command":"ls"}' },
      { kind: 'tool-result', call: (head + 2) as never, text: 'a.txt' },
      { kind: 'assistant', text: 'there is one file' },
    ]
    const result = agent.injectBatch(entries)
    expect(result.seqs).toHaveLength(5)
    expect(agent.session.deriveMessages()).toHaveLength(4)
  })
})
