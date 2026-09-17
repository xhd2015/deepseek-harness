/**
 * `dsh web open` client: create a Workspace and Session on the running GUI,
 * then open the authenticated session URL.
 * @module @deepseek-ai/dsh-web-app/open
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { internals as cmdlineInternals } from '@deepseek-ai/dsh-cmdline'
import { WEB_STARTUP_SERVICE, type WebStartupValues } from './startup.ts'
import { readWebListenFile } from './listen-file.ts'
import { openerInternals } from './opener.ts'
import type { WebBrowserId } from './browsers.ts'

/** Stable Cordis plugin name. */
export const name = 'web-open'

/** Wait for parsed flags before talking to a running GUI. */
export const inject = [WEB_STARTUP_SERVICE]

const SESSION_QUERY = 'session'

interface RpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

interface RpcFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

type RpcResult<T> = RpcSuccess<T> | RpcFailure

/**
 * Run the `open` client when this invocation asked for it.
 * @param ctx - plugin context carrying webStartup and appExit.
 */
export function apply(ctx: Context): void {
  const startup = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
  if (startup === undefined || startup.mode !== 'open') return
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('web-open: the launcher must provide ctx.appExit')
  const directory = startup.directory
  if (directory === undefined) throw new Error('web-open: open mode requires a directory')
  ctx.effect(() => {
    const lifetime = new AbortController()
    void runOpen({
      directory,
      openBrowser: startup.openBrowser,
      ...startup.browser === undefined ? {} : { browser: startup.browser },
      signal: lifetime.signal,
    }).then(
      (sessionId) => {
        cmdlineInternals.stdout.write(`dsh web: opened ${sessionId} in ${directory}\n`)
        exit(0)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        cmdlineInternals.stderr.write(`dsh: ${message}\n`)
        exit(1)
      },
    )
    return () => { lifetime.abort() }
  }, 'web-open: create session on running GUI')
}

interface OpenRequest {
  readonly directory: string
  readonly openBrowser: boolean
  readonly browser?: WebBrowserId
  readonly signal: AbortSignal
}

/**
 * Create a Workspace and Session on the recorded listen origin, then optionally
 * open a browser to that Session.
 * @param request - directory, browser handoff, and cancellation.
 * @returns the created Session id.
 */
export async function runOpen(request: OpenRequest): Promise<string> {
  const listen = internals.readListen()
  if (listen === undefined) {
    throw new Error('web is not serving; start it with: dsh web')
  }
  const created = await createWorkspaceAndSession(listen.origin, listen.token, request.directory, request.signal)
  if (request.openBrowser) {
    const url = sessionLaunchUrl(listen.origin, listen.token, created.sessionId)
    await openerInternals.openBrowser(url, request.browser)
  }
  return created.sessionId
}

async function createWorkspaceAndSession(
  origin: string,
  token: string,
  directory: string,
  signal: AbortSignal,
): Promise<{ sessionId: string }> {
  const workspace = await rpc<{ workspace: { workspaceId: string } }>(
    origin,
    token,
    'workspace/create',
    { request: { path: directory } },
    signal,
  )
  const session = await rpc<{ sessionId: string }>(
    origin,
    token,
    'session/create',
    { request: { workspaceId: workspace.workspace.workspaceId } },
    signal,
  )
  return { sessionId: session.sessionId }
}

async function rpc<T>(
  origin: string,
  token: string,
  endpoint: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const rpcId = randomUUID()
  let response: Response
  try {
    response = await internals.fetch(new URL(`/api/${endpoint}`, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('web is not serving; start it with: dsh web')
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('web is not serving; start it with: dsh web')
  }
  if (!response.ok) {
    throw new Error(`web RPC ${endpoint} failed: HTTP ${String(response.status)}`)
  }
  const body: unknown = await response.json()
  const result = rpcResult<T>(body, rpcId, endpoint)
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

function rpcResult<T>(body: unknown, rpcId: string, endpoint: string): RpcResult<T> {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`web RPC ${endpoint} returned a non-object`)
  }
  const envelope = body as Record<string, unknown>
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
    throw new Error(`web RPC ${endpoint} returned an invalid envelope`)
  }
  const result = envelope.result
  if (typeof result !== 'object' || result === null || !('ok' in result)) {
    throw new Error(`web RPC ${endpoint} returned an invalid result`)
  }
  return result as RpcResult<T>
}

function sessionLaunchUrl(origin: string, token: string, sessionId: string): string {
  const url = new URL(origin)
  url.pathname = '/'
  url.searchParams.set('token', token)
  url.searchParams.set(SESSION_QUERY, sessionId)
  return url.href
}

/** Test hooks; production never mutates them. */
export const internals: {
  fetch: typeof fetch
  readListen: typeof readWebListenFile
} = {
  fetch,
  readListen: readWebListenFile,
}
