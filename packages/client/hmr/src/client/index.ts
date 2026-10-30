/** Web SSE transport for entry reconciliation and rebuilt code replacement; the SharedWorker relay shares one socket across tabs. */
import type { Context } from '@deepseek-ai/cordis'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import type { PluginsEventParseResult } from '../events.ts'
import { EVENTS_ROUTE, parsePluginsEventFrame } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required service: the client module system whose entry controller handles received frames. */
export const inject = ['modules']

/** Request carrier a shell installs when it owns the page transport, such as the worker preview's tunnel. */
type PageTransportFetch = (input: string, init: RequestInit) => Promise<Response>

/** Page global carrying the shell transport; absent in the served web app. */
interface PageTransportGlobal {
  __DSH_TRANSPORT__?: { fetch?: PageTransportFetch }
}

/**
 * Page-relative script URL of the Gateway SharedWorker relay; the browser
 * resolves it against the document base, so this module never needs the
 * `location` global itself. Mirrors the Gateway's served mux worker path.
 */
const REMOTE_SHARED_MUX_WORKER_PATH = '/api/remote.shared-mux-worker.js'

/** Whether a Gateway SharedWorker relay frame carries one raw HMR SSE payload. */
function isHmrEvent(value: unknown): value is { readonly type: 'hmr-event'; readonly data: string } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'hmr-event'
    && typeof (value as { data?: unknown }).data === 'string'
}

/**
 * Read the document-relative events route through a shell-owned transport until it closes or `signal` aborts.
 * @param fetch - The shell's request carrier.
 * @param signal - Aborts the stream when the plugin disposes.
 * @param receive - Handles one SSE `data` payload.
 * @throws Error when the Host refuses the stream or the stream ends while the plugin is active.
 */
async function readPageTransportEvents(fetch: PageTransportFetch, signal: AbortSignal, receive: (data: string) => void): Promise<void> {
  const response = await fetch(EVENTS_ROUTE, { method: 'GET', headers: { accept: 'text/event-stream' }, signal })
  if (!response.ok || response.body === null) {
    throw new Error(`client-hmr: ${EVENTS_ROUTE} answered ${String(response.status)}`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    receive(value.data)
  }
  if (!signal.aborted) throw new Error(`client-hmr: ${EVENTS_ROUTE} closed; client graph changes stop until the page reloads`)
}

/**
 * Forward graph snapshots and rebuilds to the page's shared serial controller. The event stream arrives through the
 * shell transport when the page has one, otherwise through the Gateway SharedWorker relay.
 * @param ctx - Plugin context with the client module system.
 */
export function apply(ctx: Context): void {
  const entries = ctx.modules.entries
  const handle = (frame: Extract<PluginsEventParseResult, { kind: 'frame' }>['frame']): void => {
    const run = frame.type === 'graph'
      ? Promise.resolve().then(() => entries.sync(frame.graph))
      : entries.reload(frame.id, frame.rev)
    void run.catch((error: unknown) => { ctx.logger.error(error) })
  }
  const receive = (data: string): void => {
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      // Wire boundary: a malformed transport frame is dropped loudly.
      ctx.logger.warn(`client-hmr: unparseable event frame: ${data}`)
      return
    }
    const parsed = parsePluginsEventFrame(value)
    if (parsed.kind === 'invalid') {
      ctx.logger.warn(`client-hmr: invalid event frame: ${data}`)
    } else if (parsed.kind === 'frame') {
      handle(parsed.frame)
    }
  }

  ctx.effect(() => {
    const transport = (globalThis as PageTransportGlobal).__DSH_TRANSPORT__
    if (transport?.fetch !== undefined) {
      const controller = new AbortController()
      void readPageTransportEvents(transport.fetch, controller.signal, receive).catch((error: unknown) => {
        if (!controller.signal.aborted) ctx.logger.error(error)
      })
      return () => { controller.abort() }
    }
    const worker = new SharedWorker(
      REMOTE_SHARED_MUX_WORKER_PATH,
      { type: 'module', name: 'dsh-gateway-mux' },
    )
    const { port } = worker
    port.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isHmrEvent(event.data)) return
      receive(event.data.data)
    })
    port.start()
    return () => { port.close() }
  }, 'client-hmr: event source')
}
