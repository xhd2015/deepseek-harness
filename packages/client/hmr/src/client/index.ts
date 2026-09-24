/** Web SSE transport for entry reconciliation and rebuilt code replacement; the SharedWorker relay shares one socket across tabs. */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginsEventParseResult } from '../events.ts'
import { parsePluginsEventFrame } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required service: the client module system whose entry controller handles received frames. */
export const inject = ['modules']

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
 * Forward graph snapshots and rebuilds to the page's shared serial controller.
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

  ctx.effect(() => {
    // A page-relative script URL: the browser resolves it against the document
    // base, so this module never needs the `location` global itself.
    const worker = new SharedWorker(
      REMOTE_SHARED_MUX_WORKER_PATH,
      { type: 'module', name: 'dsh-gateway-mux' },
    )
    const { port } = worker
    port.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isHmrEvent(event.data)) return
      let value: unknown
      try {
        value = JSON.parse(event.data.data) as unknown
      } catch {
        // Wire boundary: a malformed transport frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data.data}`)
        return
      }
      const parsed = parsePluginsEventFrame(value)
      if (parsed.kind === 'invalid') {
        ctx.logger.warn(`client-hmr: invalid event frame: ${event.data.data}`)
      } else if (parsed.kind === 'frame') {
        handle(parsed.frame)
      }
    })
    port.start()
    return () => { port.close() }
  }, 'client-hmr: event source')
}
