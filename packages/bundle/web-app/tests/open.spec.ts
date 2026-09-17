/** `dsh web open` client against a recorded listen origin. */

import { afterEach, describe, expect, it } from 'vitest'
import { internals, runOpen } from '../src/open.ts'
import { openerInternals } from '../src/opener.ts'

afterEach(() => {
  internals.fetch = fetch
  internals.readListen = () => undefined
  openerInternals.openBrowser = async () => {}
})

describe('runOpen', () => {
  it('fails when no listen record is present', async () => {
    internals.readListen = () => undefined
    await expect(runOpen({
      directory: '/tmp/proj',
      openBrowser: true,
      signal: new AbortController().signal,
    })).rejects.toThrow('web is not serving; start it with: dsh web')
  })

  it('creates a workspace and session then opens the session URL', async () => {
    const opened: Array<{ url: string; browser?: string }> = []
    internals.readListen = () => ({
      pid: process.pid,
      origin: 'http://127.0.0.1:3080',
      token: 'launch-token',
    })
    openerInternals.openBrowser = async (url, browser) => {
      opened.push(browser === undefined ? { url } : { url, browser })
    }
    const calls: string[] = []
    internals.fetch = (async (input: URL, init?: RequestInit) => {
      const endpoint = new URL(input).pathname
      calls.push(endpoint)
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      if (endpoint === '/api/workspace/create') {
        return Response.json({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { workspace: { workspaceId: 'ws-1' }, created: true } },
        })
      }
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { sessionId: 'session-abc' } },
      })
    }) as typeof fetch

    const sessionId = await runOpen({
      directory: '/tmp/proj',
      openBrowser: true,
      browser: 'brave',
      signal: new AbortController().signal,
    })
    expect(sessionId).toBe('session-abc')
    expect(calls).toEqual(['/api/workspace/create', '/api/session/create'])
    expect(opened).toEqual([{
      url: 'http://127.0.0.1:3080/?token=launch-token&session=session-abc',
      browser: 'brave',
    }])
  })
})
