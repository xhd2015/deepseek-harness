/** Host REST routes ride the page transport when the embedding page provides one, and fall back to the browser fetch. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffUrl, type ChangesDiff } from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'

afterEach(() => { vi.unstubAllGlobals() })

const SESSION = SessionId('embedded')
const HOST = { name: 'mac-host', available: true, fileManager: 'finder' }
const diff: ChangesDiff = {
  kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
}

function transportFetchStub(): ReturnType<typeof vi.fn> {
  const browserFetch = vi.fn()
  vi.stubGlobal('fetch', browserFetch)
  const carrier = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch: carrier })
  return carrier
}

it('routes Host REST reads and open gestures through the page transport', async () => {
  const carrier = transportFetchStub()
  carrier.mockResolvedValue(Response.json(HOST))
  const controller = new PresentedOpenController()
  await controller.loadHost()
  expect(carrier).toHaveBeenCalledWith('api/present.host', expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }))
  expect(controller.host.getSnapshot()).toEqual(HOST)
  carrier.mockResolvedValue(new Response(null, { status: 204 }))
  await controller.open(SESSION, 2, 1)
  expect(carrier).toHaveBeenCalledWith('api/present.open?sessionId=embedded&seq=2&index=1', expect.objectContaining({ method: 'POST' }))
  expect(controller.state.getSnapshot()['api/present.open?sessionId=embedded&seq=2&index=1']).toBe('opened')
  await controller.dispose()
  expect(carrier.mock.calls.every(([input]) => String(input).startsWith('api/'))).toBe(true)
})

it('resolves the transport per call and serves comparison reads through it', async () => {
  const store = new ChangesDiffStore()
  const browserFetch = vi.fn()
  vi.stubGlobal('fetch', browserFetch)
  const carrier = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
  // Injected after the store exists: a module-load capture would miss it.
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch: carrier })
  carrier.mockResolvedValue(Response.json(diff))
  await store.load(SESSION, 5, 1)
  expect(carrier).toHaveBeenCalledWith(changesDiffUrl(SESSION, 5, 1),
    { signal: expect.any(AbortSignal) as AbortSignal })
  expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 1)]).toEqual(diff)
  expect(browserFetch).not.toHaveBeenCalled()
})

it('falls back to the browser fetch when the page ships no transport', async () => {
  const fetcher = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  fetcher.mockResolvedValue(Response.json(HOST))
  await controller.loadHost()
  expect(fetcher).toHaveBeenCalledWith('api/present.host', expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }))
  expect(controller.host.getSnapshot()).toEqual(HOST)
  await controller.dispose()
})
