import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import {
  listingOrigin,
  parseLiveListing,
  profilesFromListing,
  requestBaseURLForProtocol,
} from '../src/live-catalog.ts'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
})

/**
 * Serve one handler on an ephemeral loopback port.
 * @param handler - request handler.
 * @returns the origin to point a live shell at.
 */
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

/**
 * Serve a live listing and record the credential each probe presented.
 * @param rows - listing rows.
 * @param probes - receives every request's `authorization` header.
 * @returns the origin to point a live shell at.
 */
function listingServer(rows: readonly Record<string, unknown>[], probes: (string | undefined)[]): Promise<string> {
  return listen((request, response) => {
    if (request.url !== '/v1/models') {
      response.writeHead(404)
      response.end()
      return
    }
    probes.push(request.headers.authorization)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: rows }))
  })
}

/**
 * Wait for the live probe, then read one route's served models. An unknown
 * route throws; a registered route answers even with no models, which is how a
 * route whose credential does not resolve reports itself.
 * @param ctx - context with the llm runtime and the pi-ai plugin.
 * @param provider - synthesized route id.
 * @returns the served models.
 */
async function listedModels(ctx: Context, provider: string): Promise<readonly { id: string }[]> {
  const deadline = Date.now() + 4000
  for (;;) {
    try {
      return await ctx.llm.listModels(provider)
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
  }
}

describe('profilesFromListing', () => {
  const rows = parseLiveListing({
    data: [
      {
        id: 'grok-4.6',
        owned_by: 'grok',
        protocol: 'openai-responses',
        display_name: 'Grok 4.6',
        context_window: 500000,
        input_modalities: ['text', 'image'],
        reasoning: { disabled: false, default_effort: 'high', efforts: ['low', 'high', 'xhigh'] },
      },
      {
        id: 'claude-sonnet-5-5',
        owned_by: 'compass-api',
        protocol: 'anthropic-messages',
        input_modalities: ['text', 'image'],
      },
    ],
  })

  it('splits aggregated gateways by owned_by', () => {
    const profiles = profilesFromListing({
      id: 'llm-proxy',
      baseURL: 'http://127.0.0.1:8890',
      groupByProviders: true,
      apiKeyEnv: 'LLM_PROXY_API_KEY',
      timeoutMs: 1,
      maxAgeMs: 1,
    }, rows)
    expect([...profiles.keys()].sort()).toEqual(['llm-proxy-compass-api', 'llm-proxy-grok'])
    expect(profiles.get('llm-proxy-grok')?.baseURL).toBe('http://127.0.0.1:8890/v1')
    expect(profiles.get('llm-proxy-compass-api')?.baseURL).toBe('http://127.0.0.1:8890')
  })

  it('keeps a single-gateway shell as one route', () => {
    const profiles = profilesFromListing({
      id: 'compass',
      baseURL: 'https://compass.example/v1',
      groupByProviders: false,
      timeoutMs: 1,
      maxAgeMs: 1,
    }, rows.filter(row => row.ownedBy === 'compass-api'))
    expect([...profiles.keys()]).toEqual(['compass'])
    expect(requestBaseURLForProtocol(listingOrigin('https://compass.example/v1'), 'anthropic-messages'))
      .toBe('https://compass.example')
  })
})

describe('dynamic listing shells in resolveProfiles', () => {
  it('accepts a shell without models and refuses a models list beside it', () => {
    expect(() => resolveProfiles({
      gw: { modelListingMode: 'dynamic', baseURL: 'http://127.0.0.1:8890' },
    })).not.toThrow()
    expect(() => resolveProfiles({
      gw: { modelListingMode: 'dynamic', baseURL: 'http://127.0.0.1:8890', models: [{ id: 'x' }] },
    })).toThrow(/beside a models list/)
  })
})

describe('live catalog plugin', () => {
  const grokRow = {
    id: 'grok-4.6',
    owned_by: 'grok',
    protocol: 'openai-responses',
    display_name: 'Grok 4.6',
    context_window: 500000,
    input_modalities: ['text', 'image'],
    reasoning: { disabled: false, efforts: ['high'] },
  }

  it('registers grouped routes from GET /v1/models', async () => {
    const probes: (string | undefined)[] = []
    const origin = await listingServer([grokRow], probes)
    vi.stubEnv('LIVE_CATALOG_KEY', 'probe')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'llm-proxy': {
          modelListingMode: 'dynamic',
          groupByProviders: true,
          baseURL: origin,
          apiKeyEnv: 'LIVE_CATALOG_KEY',
        },
      },
    })
    expect((await listedModels(ctx, 'llm-proxy-grok')).map(model => model.id)).toEqual(['grok-4.6'])
    expect(probes).toEqual(['Bearer probe'])
    await ctx.fiber.dispose()
  })

  it('refreshListings re-probes the gateway before max-age', async () => {
    const rows: Record<string, unknown>[] = [{ ...grokRow }]
    const origin = await listingServer(rows, [])
    vi.stubEnv('LIVE_CATALOG_KEY', 'probe')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'llm-proxy': {
          modelListingMode: 'dynamic',
          groupByProviders: true,
          baseURL: origin,
          apiKeyEnv: 'LIVE_CATALOG_KEY',
        },
      },
    })
    expect((await listedModels(ctx, 'llm-proxy-grok')).map(model => model.id)).toEqual(['grok-4.6'])
    rows[0] = { ...grokRow, id: 'grok-4.7', display_name: 'Grok 4.7' }
    await ctx.llm.refreshListings()
    expect((await listedModels(ctx, 'llm-proxy-grok')).map(model => model.id)).toEqual(['grok-4.7'])
    await ctx.fiber.dispose()
  })

  it('asks the gateway to narrow variants to the shell runner', async () => {
    const requested: string[] = []
    const origin = await listen((request, response) => {
      requested.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [grokRow] }))
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('modelListingDynamic' as never, {
      get: () => [{ id: 'gw', baseURL: origin, groupByProviders: true, apiKeyEnv: 'GW_API_KEY', agentRunner: 'dsh' }],
    } as never)
    await ctx.plugin(LlmPiAi, { providers: {} })
    expect((await listedModels(ctx, 'gw-grok')).map(model => model.id)).toEqual(['grok-4.6'])
    expect(requested).toEqual(['/v1/models?agent-runner=dsh'])
    await ctx.fiber.dispose()
  })

  it('injects a credential for a launcher shell that configures none', async () => {
    const probes: (string | undefined)[] = []
    const origin = await listingServer([grokRow], probes)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('modelListingDynamic' as never, {
      get: () => [{ id: 'gw', baseURL: origin, groupByProviders: true, apiKeyEnv: 'GW_API_KEY' }],
    } as never)
    await ctx.plugin(LlmPiAi, { providers: {} })
    // A non-empty list also proves the request path resolved a credential:
    // `listModels` answers [] when a route's apiKeyEnv does not resolve.
    expect((await listedModels(ctx, 'gw-grok')).map(model => model.id)).toEqual(['grok-4.6'])
    expect(probes).toEqual(['Bearer dsh-live-listing'])
    await ctx.fiber.dispose()
  })

  it('prefers a resolved credential over the injected one', async () => {
    const probes: (string | undefined)[] = []
    const origin = await listingServer([grokRow], probes)
    vi.stubEnv('GW_API_KEY', 'stored')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('modelListingDynamic' as never, {
      get: () => [{ id: 'gw', baseURL: origin, groupByProviders: true, apiKeyEnv: 'GW_API_KEY' }],
    } as never)
    await ctx.plugin(LlmPiAi, { providers: {} })
    expect((await listedModels(ctx, 'gw-grok')).map(model => model.id)).toEqual(['grok-4.6'])
    expect(probes).toEqual(['Bearer stored'])
    await ctx.fiber.dispose()
  })

  it('keeps a launcher shell credential fail-loud when the flag names it', async () => {
    const probes: (string | undefined)[] = []
    const origin = await listingServer([grokRow], probes)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('modelListingDynamic' as never, {
      get: () => [{ id: 'gw', baseURL: origin, groupByProviders: true, apiKeyEnv: 'GW_UNSET' }],
    } as never)
    await ctx.plugin(LlmPiAi, { providers: {} })
    // The route registers, but serves nothing: only the name this plugin
    // derived from the flag falls back to the placeholder.
    expect(await listedModels(ctx, 'gw-grok')).toEqual([])
    expect(probes).toEqual([undefined])
    await ctx.fiber.dispose()
  })
})
