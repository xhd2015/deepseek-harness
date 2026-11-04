/** Shipped Web composition, public create/prompt RPCs, and a recorded first request on a Session-only route. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { ModelCatalog, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/session-initial-model/session.v4.jsonl', import.meta.url))

it('creates a Session-only model and effort before its first request without saving defaults', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: FIXTURE, compareReplaySession: true,
    replayProviders: [{ id: 'adhoc', name: 'Adhoc', models: [{
      id: 'session-model', name: 'Session Model', contextWindow: 128000,
      reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'high',
    }] }],
  })
  const rpc = async <T>(method: string, args: Record<string, unknown>): Promise<RemoteResult<T>> => {
    const rpcId = randomUUID()
    const response = await scaffold.hostFetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    expect(response.status).toBe(200)
    const envelope = await response.json() as { type: string; rpcId: string; result: RemoteResult<T> }
    expect(envelope).toMatchObject({ type: 'server-response', rpcId })
    return envelope.result
  }
  try {
    const catalog = await rpc<ModelCatalog>('session/modelCatalog', {})
    expect(catalog).toMatchObject({ ok: true, value: { groups: [{ id: 'adhoc', models: [{
      id: 'session-model', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] },
    }] }] } })
    if (!catalog.ok) throw new Error('expected a live model catalog')
    const defaultBefore = catalog.value.default
    const sessionId = SessionId('session-only-model')
    const modelSelection = { provider: 'adhoc', model: 'session-model', reasoningEffort: 'max' }
    const create = { request: { sessionId, cwd: scaffold.workspaceCwd, modelSelection } }
    expect(await rpc<SessionCreateValue>('session/create', create))
      .toEqual({ ok: true, value: { sessionId, agentPreset: 'standard', modelSelection } })
    expect(await rpc<SessionCreateValue>('session/create', create))
      .toEqual({ ok: true, value: { sessionId, agentPreset: 'standard', modelSelection } })
    const settled = scaffold.whenTurnSettled()
    expect(await rpc('session/prompt', { request: {
      sessionId, requestId: 'initial-model-prompt', mode: 'queue', clientTimeZone: 'Asia/Shanghai',
      content: [{ type: 'text', text: fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0] }],
    } })).toEqual({ ok: true, value: { accepted: true } })
    expect(await settled).toBe(sessionId)
    const session = scaffold.ctx.sessions.get(sessionId)!
    expect(session.requestHeader()?.config).toEqual(modelSelection)
    expect(session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message.content))
      .toContainEqual([{ type: 'text', text: 'WEB_E2E_OK\n' }])
    expect(await rpc<ModelCatalog>('session/modelCatalog', {}))
      .toMatchObject({ ok: true, value: { default: defaultBefore } })
  } finally {
    await scaffold.close()
  }
}, 120_000)
