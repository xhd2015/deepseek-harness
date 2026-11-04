/** Real Loader composition: several sockets own one routing service and one lifetime. */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import WebServer, { type Config } from '../src/index.ts'
import { materializeTlsFixture } from './tls-fixture.ts'

const ipv6 = Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv6' && address.address === '::1')
const scoped = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? [])
  .filter(address => address.family === 'IPv6' && address.address.startsWith('fe80:'))
  .map(address => address.address.includes('%') ? address.address : `${address.address}%${name}`))[0]
const roots: string[] = []
const contexts: Context[] = []
const probes: Server[] = []
const sockets: Socket[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(probes.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-multi-listen-'))
  roots.push(root)
  return root
}

async function boot(config: Config): Promise<Context> {
  const root = temporaryRoot()
  const path = join(root, 'cordis.yml')
  writeFileSync(path, `- id: multi-listen\n  name: cordis:multi-listen\n  config: ${JSON.stringify(config)}\n`)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['multi-listen'] = WebServer
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  return ctx
}

async function bindProbe(host: string, port = 0): Promise<Server> {
  const server = createServer()
  probes.push(server)
  const bound = once(server, 'listening')
  server.listen({ host, port, ipv6Only: host.includes(':') })
  await bound
  return server
}

function httpsText(host: string, port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Verify the fixture's localhost DNS identity while dialing each concrete IP.
    const request = httpsRequest({ host, port, path: '/shared', ca, servername: 'localhost', headers: { Host: 'localhost' }, agent: false }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => { resolve(text) })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

describe('multi-address configuration', () => {
  it.skipIf(scoped === undefined)('binds a real scoped interface without inventing a browser URL', async () => {
    const host = scoped!
    const ctx = await boot({ hosts: [host], port: 0 })
    const server = ctx.webServer
    const port = server.port!
    expect(server.getLocalOrigin()).toBeUndefined()
    expect(() => server.getOrigin()).toThrow(/interface zone id/u)
    expect(server.endpoints).toEqual([{ host, port }])
    server.register({ kind: 'exact', path: '/scoped', handler: (_req, res) => { res.end('scoped listener') } })
    const text = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({ hostname: host, port, path: '/scoped', headers: { Host: 'scoped.test' }, agent: false }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { text += chunk })
        response.on('end', () => { resolve(text) })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    expect(text).toBe('scoped listener')
    await ctx.fiber.dispose()
    await bindProbe(host, port)
  })

  it('preserves legacy host, rejects conflicting or empty lists, and validates every address', () => {
    expect(WebServer.Config({ host: '127.0.0.1', port: 0 }).host).toBe('127.0.0.1')
    expect(() => new WebServer(new Context(), WebServer.Config({ host: '127.0.0.1', hosts: ['::1'], port: 0 }))).toThrow(/mutually exclusive/u)
    expect(() => new WebServer(new Context(), WebServer.Config({ hosts: [], port: 0 }))).toThrow(/at least one/u)
    expect(() => WebServer.Config({ hosts: ['127.0.0.1', '::'], port: 0 })).toThrow(/wildcard/u)
    expect(() => WebServer.Config({ hosts: ['127.0.0.1', 'localhost'], port: 0 })).toThrow(/literal/u)
  })

  it('deduplicates equivalent addresses while keeping distinct interface scopes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const server = new WebServer(ctx, WebServer.Config({
      hosts: ['127.0.0.1', '::ffff:127.0.0.1', '::1', '0:0:0:0:0:0:0:1', 'fe80::1%en7', 'fe80::1%en8'], port: 0,
    }))
    expect(server.hosts).toEqual(['127.0.0.1', '::1', 'fe80::1%en7', 'fe80::1%en8'])
    expect(server.endpoints).toEqual([])
  })

  it('keeps a single IPv4-mapped binding consistent with its actual IPv4 socket', async () => {
    const ctx = await boot({ hosts: ['::ffff:127.0.0.1'], port: 0 })
    expect(ctx.webServer.hosts).toEqual(['127.0.0.1'])
    expect(ctx.webServer.getLocalOrigin()).toBe(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  })
})

describe.skipIf(!ipv6)('real IPv4 and IPv6 listener group', () => {
  it('uses one dynamically chosen port and route state, and prefers local IPv4 even when configured second', async () => {
    const ctx = await boot({ hosts: ['::1', '127.0.0.1'], port: 0 })
    const server = ctx.webServer
    const port = server.port!
    let calls = 0
    server.register({ kind: 'exact', path: '/shared', handler: (_req, res) => { res.end(String(++calls)) } })
    expect(await (await fetch(`http://127.0.0.1:${port}/shared`)).text()).toBe('1')
    expect(await (await fetch(`http://[::1]:${port}/shared`)).text()).toBe('2')
    expect(server.endpoints).toEqual([{ host: '::1', port }, { host: '127.0.0.1', port }])
    expect(server.getOrigin()).toBe(`http://127.0.0.1:${port}`)
    await ctx.fiber.dispose()
    expect(server.endpoints).toEqual([])
    await bindProbe('127.0.0.1', port)
    await bindProbe('::1', port)
  })

  it('rolls back the earlier IPv4 listener when the IPv6 port is occupied', async () => {
    const occupied = await bindProbe('::1')
    const port = (occupied.address() as AddressInfo).port
    const ctx = await boot({ hosts: ['127.0.0.1', '::1'], port })
    const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:multi-listen')?.fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow(/all listeners rolled back.*EADDRINUSE/u)
    expect(ctx.get('webServer')).toBeUndefined()
    await bindProbe('127.0.0.1', port)
  })

  it('streams SSE from both addresses and closes both streams with the owner', async () => {
    const ctx = await boot({ hosts: ['127.0.0.1', '::1'], port: 0 })
    ctx.webServer.register({ kind: 'exact', path: '/events', handler: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: shared\n\n')
    } })
    const port = ctx.webServer.port!
    const readers = await Promise.all(['127.0.0.1', '[::1]'].map(async (host) => {
      const response = await fetch(`http://${host}:${port}/events`)
      if (response.body === null) throw new Error('SSE response had no body')
      const reader = response.body.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: shared\n\n')
      return reader
    }))
    await ctx.fiber.dispose()
    for (const reader of readers) {
      expect(await reader.read().then(value => value.done, () => true)).toBe(true)
      reader.releaseLock()
    }
  })

  it('upgrades both addresses through the shared registry and tears down both sockets', async () => {
    const ctx = await boot({ hosts: ['127.0.0.1', '::1'], port: 0 })
    ctx.webServer.registerUpgrade({ path: '/events', handler: (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })
    for (const host of ['127.0.0.1', '::1']) {
      const socket = connect(ctx.webServer.port!, host)
      sockets.push(socket)
      await once(socket, 'connect')
      const response = once(socket, 'data')
      socket.write('GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      expect(String((await response)[0])).toContain('101 Switching Protocols')
    }
    const closed = sockets.map(socket => once(socket, 'close'))
    await ctx.fiber.dispose()
    await Promise.all(closed)
  })

  it('serves both listeners with the same verified TLS material and shared route state', async () => {
    const tls = await materializeTlsFixture(temporaryRoot())
    const ctx = await boot({ hosts: ['127.0.0.1', '::1'], port: 0, tls })
    let calls = 0
    ctx.webServer.register({ kind: 'exact', path: '/shared', handler: (_req, res) => { res.end(String(++calls)) } })
    expect(await httpsText('127.0.0.1', ctx.webServer.port!, tls.ca)).toBe('1')
    expect(await httpsText('::1', ctx.webServer.port!, tls.ca)).toBe('2')
    expect(ctx.webServer.getOrigin()).toBe(`https://127.0.0.1:${String(ctx.webServer.port)}`)
  })
})
