/** Web transport delegates module and entry changes to the page-owned controller. */
import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('forwards full graphs and rebuilt frames, contains wire errors and closes its SharedWorker port', async () => {
  const ctx = new Context()
  const sync = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  ctx.provide('modules', { entries: { sync, reload } } as unknown as ClientModuleLoader)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  let receive!: (event: { data: { type: string; data: string } }) => void
  const close = vi.fn()
  const start = vi.fn()
  vi.stubGlobal('location', { origin: 'https://gateway.test' })
  vi.stubGlobal('SharedWorker', class {
    port = {
      addEventListener: (_name: string, listener: typeof receive) => { receive = listener },
      start,
      close,
    }
  })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    const relayed = (payload: string) => ({ data: { type: 'hmr-event', data: payload } })
    const graph = { rev: 'r', entries: [], batches: [] }
    receive(relayed(JSON.stringify({ type: 'graph', graph })))
    receive(relayed(JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' })))
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
    expect(reload).toHaveBeenCalledWith('a', 'r1')
    receive(relayed('{'))
    receive(relayed(JSON.stringify({ type: 'graph', graph: null })))
    receive(relayed(JSON.stringify({ type: 'future' })))
    expect(warnings).toHaveBeenCalledTimes(2)
    sync.mockRejectedValueOnce(new Error('invalid graph'))
    receive(relayed(JSON.stringify({ type: 'graph', graph: {} })))
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid graph' })) })
    expect(start).toHaveBeenCalledOnce()
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
  expect(close).toHaveBeenCalledOnce()
})
