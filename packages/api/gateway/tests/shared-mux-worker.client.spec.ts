/**
 * The browser-wide mux Worker owns one physical socket for every tab, so a
 * carrier it cannot settle must not outlive its handshake window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRemoteStreamClientMessage, type RemoteStreamClientMessage } from '../src/stream-protocol.ts'

/** One physical carrier the Worker created, driven by the case under test. */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly created: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []
  readonly closed: { code: number | undefined; reason: string | undefined }[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor() { FakeWebSocket.created.push(this) }

  send(data: string): void { this.sent.push(data) }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const table = this.listeners.get(type) ?? new Set()
    table.add(listener)
    this.listeners.set(type, table)
  }

  /** Deliver one carrier event the way the browser would. */
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

/** One page's MessagePort, recording what the Worker sends back. */
interface FakePort extends MessagePort {
  readonly posted: unknown[]
  deliver(value: unknown): void
}

function fakePort(): FakePort {
  const listeners: ((event: { data: unknown }) => void)[] = []
  const posted: unknown[] = []
  return {
    posted,
    postMessage: (value: unknown) => { posted.push(value) },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => { listeners.push(listener) },
    start: () => {},
    close: () => {},
    deliver: (value: unknown) => { for (const listener of listeners) listener({ data: value }) },
  } as unknown as FakePort
}

function open(streamId: string): RemoteStreamClientMessage {
  return { type: 'open', streamId, endpoint: '$events', payload: { args: {} } }
}

/** Load the Worker module against stubbed browser globals and return its connect entry. */
async function worker(): Promise<(port: MessagePort) => void> {
  const connects: ((event: unknown) => void)[] = []
  const globals = globalThis as Record<string, unknown>
  globals.self = {
    // The Worker derives its channel from its own script path.
    location: { origin: 'http://127.0.0.1:8422', pathname: '/api/remote.shared-mux-worker.js' },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'connect') connects.push(listener)
    },
  }
  globals.WebSocket = FakeWebSocket
  globals.EventSource = class {
    addEventListener(): void {}
    close(): void {}
  }
  await import('../src/client/shared-mux-worker.ts')
  return (port) => { for (const connect of connects) connect({ ports: [port] }) }
}

afterEach(() => {
  FakeWebSocket.created.length = 0
  vi.useRealTimers()
  vi.resetModules()
})

describe('shared mux Worker', () => {
  it('abandons a handshake that never settles so a later open still starts one', async () => {
    vi.useFakeTimers()
    const connect = await worker()
    const port = fakePort()
    connect(port)

    port.deliver(open('stalled'))
    expect(FakeWebSocket.created).toHaveLength(1)
    expect(FakeWebSocket.created[0]!.readyState).toBe(FakeWebSocket.CONNECTING)

    // The carrier never opens, errors, or closes. The next open must not queue
    // behind it forever: the Worker has to give the slot back.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.created[0]!.closed).toHaveLength(1)

    port.deliver(open('fresh'))
    expect(FakeWebSocket.created).toHaveLength(2)
    expect(FakeWebSocket.created[1]!.readyState).toBe(FakeWebSocket.CONNECTING)
  })

  it('reports the abandoned streams to their pages instead of holding them', async () => {
    vi.useFakeTimers()
    const connect = await worker()
    const port = fakePort()
    connect(port)

    port.deliver(open('stalled'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(port.posted).toContainEqual({ type: 'lost', streamId: 'stalled' })
  })

  it('keeps one shared carrier while the handshake is still inside its window', async () => {
    vi.useFakeTimers()
    const connect = await worker()
    const port = fakePort()
    connect(port)

    port.deliver(open('first'))
    await vi.advanceTimersByTimeAsync(9_000)
    port.deliver(open('second'))
    expect(FakeWebSocket.created).toHaveLength(1)
  })

  it('flushes the queued opens and disarms the window once the carrier opens', async () => {
    vi.useFakeTimers()
    const connect = await worker()
    const port = fakePort()
    connect(port)

    port.deliver(open('ready-soon'))
    const carrier = FakeWebSocket.created[0]!
    carrier.readyState = FakeWebSocket.OPEN
    carrier.emit('open')

    const flushed = carrier.sent.map(frame => parseRemoteStreamClientMessage(frame))
    expect(flushed).toEqual([open('ready-soon')])
    // The settled carrier stays; the abandoned window must not close it later.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(carrier.closed).toHaveLength(0)
    expect(FakeWebSocket.created).toHaveLength(1)
  })
})
