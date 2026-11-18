/**
 * `session/status` reports the Agent registry's run truth in one batch: a
 * loaded Agent answers idle or running from its current status, and an id with
 * no Agent is absent from the answer instead of reading as idle, so a reader
 * that also watches process leases can fall back on them. Access filtering is
 * the remote-access spec's subject.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionStatusValue } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** Mutable test stand-in for a live Agent whose status the spec drives. */
interface StubAgent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context
  status: 'idle' | 'running'
}

interface Harness {
  readonly ctx: Context
  /** Register one loaded Agent over a fresh attached Session. */
  readonly loaded: (id: string, status: 'idle' | 'running') => Session
  /** Drive one registered Agent's status the way a turn would. */
  readonly setStatus: (id: string, status: 'idle' | 'running') => void
  /** Answer one `session/status` call. */
  readonly status: (ids?: readonly SessionId[]) => Promise<SessionStatusValue>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
    cwd: '/proj',
  })
  const agents = new Map<string, StubAgent>()
  const loaded = (id: string, status: 'idle' | 'running'): Session => {
    const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
    const agent: StubAgent = { id: session.id, session, status, ctx }
    agents.set(session.id, agent)
    ctx.agents.register(agent as unknown as Agent)
    return session
  }
  const setStatus = (id: string, status: 'idle' | 'running'): void => {
    const agent = agents.get(id)
    if (agent === undefined) throw new Error(`no registered Agent for ${id}`)
    agent.status = status
  }
  const status = async (ids?: readonly SessionId[]): Promise<SessionStatusValue> => {
    const result = await remote.status(ids === undefined ? {} : { ids })
    if (!result.ok) throw new Error(`session/status failed: ${result.error.code}`)
    return result.value
  }
  return { ctx, loaded, setStatus, status }
}

describe('session/status', () => {
  it('answers every loaded Agent when the request names no ids', async () => {
    const { loaded, status } = await harness()
    loaded('idle-session', 'idle')
    loaded('running-session', 'running')

    await expect(status()).resolves.toEqual({
      running: { 'idle-session': false, 'running-session': true },
    })
  })

  it('answers only the ids the request names and omits any id without an Agent', async () => {
    const { loaded, status } = await harness()
    loaded('idle-session', 'idle')
    loaded('running-session', 'running')

    await expect(status([sid('running-session'), sid('cold-session')])).resolves.toEqual({
      running: { 'running-session': true },
    })
    await expect(status([])).resolves.toEqual({ running: {} })
    // Asking for one id twice still answers it once.
    await expect(status([sid('idle-session'), sid('idle-session')])).resolves.toEqual({
      running: { 'idle-session': false },
    })
  })

  it('reads the Agent status at call time instead of caching the first answer', async () => {
    const { loaded, setStatus, status } = await harness()
    const session = loaded('session', 'running')
    await expect(status([session.id])).resolves.toEqual({ running: { session: true } })

    setStatus(session.id, 'idle')
    await expect(status([session.id])).resolves.toEqual({ running: { session: false } })
  })
})
