/** Host REST reads prefer the embedding page's transport over the browser fetch. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostFetch } from '../src/client/host-fetch.ts'

describe('hostFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  })

  it('uses the browser fetch when the page provides no transport', async () => {
    const browser = vi.fn(async () => new Response('served'))
    vi.stubGlobal('fetch', browser)
    const response = await hostFetch('/api/x', { method: 'POST' })
    expect(await response.text()).toBe('served')
    expect(browser).toHaveBeenCalledWith('/api/x', { method: 'POST' })
  })

  it('routes through the page transport so a proxied embedder rewrites the path', async () => {
    const browser = vi.fn(async () => new Response('browser'))
    const transport = vi.fn(async () => new Response('proxied'))
    vi.stubGlobal('fetch', browser)
    ;(globalThis as { __DSH_TRANSPORT__?: { fetch?: typeof transport } }).__DSH_TRANSPORT__ = { fetch: transport }

    const response = await hostFetch('/api/x')
    expect(await response.text()).toBe('proxied')
    expect(transport).toHaveBeenCalledWith('/api/x', {})
    expect(browser).not.toHaveBeenCalled()
  })

  it('falls back when the transport exposes no fetch', async () => {
    const browser = vi.fn(async () => new Response('served'))
    vi.stubGlobal('fetch', browser)
    ;(globalThis as { __DSH_TRANSPORT__?: Record<string, never> }).__DSH_TRANSPORT__ = {}

    expect(await (await hostFetch('/api/x')).text()).toBe('served')
    expect(browser).toHaveBeenCalledOnce()
  })
})
