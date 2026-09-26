/** `dsh web open` client against a recorded listen origin. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { internals as cmdlineInternals } from '@deepseek-ai/dsh-cmdline'
import { internals, runOpen } from '../src/open.ts'
import { openerInternals } from '../src/opener.ts'

afterEach(() => {
  internals.fetch = fetch
  internals.readListen = () => undefined
  openerInternals.openBrowser = async () => {}
  cmdlineInternals.stderr = process.stderr
})

function recordRpc(failedEndpoint?: string): Array<{ endpoint: string; request: Record<string, unknown> }> {
  const calls: Array<{ endpoint: string; request: Record<string, unknown> }> = []
  internals.readListen = () => ({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: 'launch-token' })
  internals.fetch = (async (input: URL, init?: RequestInit) => {
    const endpoint = new URL(input).pathname
    const body = JSON.parse(init?.body as string) as { rpcId: string; payload: { args: { request: Record<string, unknown> } } }
    calls.push({ endpoint, request: body.payload.args.request })
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: endpoint === failedEndpoint
        ? { ok: false, error: { code: 'test/rejected', message: 'request rejected' } }
        : { ok: true, value: endpoint === '/api/workspace/create'
          ? { workspace: { workspaceId: 'ws-1' } }
          : endpoint === '/api/session/create' ? { sessionId: 'session-abc' } : { accepted: true, text: body.payload.args.request.text } },
    })
  }) as typeof fetch
  return calls
}

describe('runOpen', () => {
  it.each([true, false])('delivers the initial text before browser launch with submit=%s', async (submit) => {
    const calls = recordRpc()
    const text = '任务\r\n'.repeat(100_000)
    const opened = vi.fn(async (url: string) => {
      expect(calls).toHaveLength(3)
      expect(new URL(url).searchParams.has('prompt')).toBe(false)
      expect(url).not.toContain(encodeURIComponent('任务'))
    })
    openerInternals.openBrowser = opened
    await expect(runOpen({ directory: '/tmp/proj', openBrowser: true, initialPrompt: { text, submit }, signal: new AbortController().signal }))
      .resolves.toBe('session-abc')
    expect(calls.map(call => call.endpoint)).toEqual([
      '/api/workspace/create', '/api/session/create', submit ? '/api/session/prompt' : '/api/session/setDraft',
    ])
    expect(calls[2]?.request).toEqual(submit
      ? { sessionId: 'session-abc', requestId: calls[2]?.request.requestId, mode: 'queue', content: [{ type: 'text', text }] }
      : { sessionId: 'session-abc', text })
    if (submit) expect(calls[2]?.request.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('submits without opening a browser when requested', async () => {
    const calls = recordRpc()
    const opened = vi.fn(async () => {})
    openerInternals.openBrowser = opened
    await runOpen({ directory: '/tmp/proj', openBrowser: false, initialPrompt: { text: 'Task', submit: true }, signal: new AbortController().signal })
    expect(calls[2]?.endpoint).toBe('/api/session/prompt')
    expect(opened).not.toHaveBeenCalled()
  })

  it.each([true, false])('identifies the created session when initial delivery fails with submit=%s', async (submit) => {
    recordRpc(submit ? '/api/session/prompt' : '/api/session/setDraft')
    const opened = vi.fn(async () => {})
    openerInternals.openBrowser = opened
    await expect(runOpen({ directory: '/tmp/proj', openBrowser: true, initialPrompt: { text: 'Task', submit }, signal: new AbortController().signal }))
      .rejects.toThrow(`session session-abc was created, but the initial ${submit ? 'prompt' : 'draft'} failed: test/rejected: request rejected`)
    expect(opened).not.toHaveBeenCalled()
  })

  it('retains session identity and emits a credential-free warning when browser launch fails', async () => {
    recordRpc()
    let stderr = ''
    cmdlineInternals.stderr = { write: (chunk: string) => { stderr += chunk; return true } }
    openerInternals.openBrowser = async (url) => { throw new Error(url) }
    await expect(runOpen({ directory: '/tmp/proj', openBrowser: true, signal: new AbortController().signal })).resolves.toBe('session-abc')
    expect(stderr).toBe('warning: session session-abc was created, but the browser could not be opened\n')
    expect(stderr).not.toContain('launch-token')
  })

  it('fails when no listen record is present, naming the file it read', async () => {
    internals.readListen = () => undefined
    await expect(runOpen({
      directory: '/tmp/proj',
      openBrowser: true,
      signal: new AbortController().signal,
    })).rejects.toThrow(/^web is not serving; start it with: dsh web \(no listen record in .+web-listen\.json\)$/u)
  })

  it('reports a rejected launch token separately from a missing server', async () => {
    internals.readListen = () => ({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: 'stale-token' })
    internals.fetch = async () => new Response('unauthorized', { status: 401 })
    await expect(runOpen({
      directory: '/tmp/proj',
      openBrowser: false,
      signal: new AbortController().signal,
    })).rejects.toThrow('web rejected the recorded launch token; restart it with: dsh web')
  })

  it('reaches a server that disabled browser authentication without a credential', async () => {
    const headers: unknown[] = []
    const opened: Array<{ url: string; browser?: string }> = []
    internals.readListen = () => ({ pid: process.pid, origin: 'http://127.0.0.1:3080' })
    openerInternals.openBrowser = async (url, browser) => {
      opened.push(browser === undefined ? { url } : { url, browser })
    }
    internals.fetch = (async (_input: URL, init?: RequestInit) => {
      headers.push(init?.headers)
      const body = JSON.parse(init?.body as string) as { rpcId: string; method: string }
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: body.method === 'workspace/create'
            ? { workspace: { workspaceId: 'ws-1' } }
            : { sessionId: 'session-abc' },
        },
      })
    }) as typeof fetch

    await expect(runOpen({
      directory: '/tmp/proj',
      openBrowser: true,
      browser: 'brave',
      signal: new AbortController().signal,
    })).resolves.toBe('session-abc')
    expect(headers).toEqual([
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
    ])
    expect(opened).toEqual([{ url: 'http://127.0.0.1:3080/?session=session-abc', browser: 'brave' }])
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
      const body = JSON.parse(init?.body as string) as { rpcId: string }
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
