/**
 * SharedWorker transport for the Gateway Remote multiplexing socket.
 *
 * Every connected document sends the existing Remote stream `open` and `cancel`
 * frames over its MessagePort. This Worker owns one physical WebSocket and
 * routes each Host frame back to the port that opened its stream id. HMR
 * subscribers also share one `/plugins/events` EventSource relay.
 */
import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
  type RemoteStreamClientMessage,
} from '../stream-protocol.ts'

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[]
}

/**
 * How long one physical handshake may stay unsettled before this Worker
 * abandons it. A stalled carrier would otherwise hold `socket` at CONNECTING
 * forever: every later logical open queues behind it, and because the browser
 * keys a SharedWorker by name, no page reload can replace the stuck instance.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000

let socket: WebSocket | undefined
let handshakeTimer: ReturnType<typeof setTimeout> | undefined
let hmrSource: EventSource | undefined
let pending: RemoteStreamClientMessage[] = []
const ports = new Set<MessagePort>()
const hmrPorts = new Set<MessagePort>()
const streams = new Map<string, MessagePort>()

/**
 * Convert the Worker script location into the Gateway's same-origin WebSocket
 * URL. The Worker is served under the configured API prefix, so its own path
 * names the channel without a second boot global.
 * @returns the absolute mux WebSocket URL.
 */
function socketUrl(): string {
  const prefix = self.location.pathname.replace(/\/remote\.shared-mux-worker\.js$/, '')
  const url = new URL(`${prefix}/remote.mux`, self.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

/** Route a terminal physical failure to every port with an active logical stream. */
function failStreams(): void {
  for (const [streamId, port] of streams) {
    port.postMessage({ type: 'lost', streamId })
  }
  streams.clear()
  pending = []
}

/**
 * Abandon the armed handshake timer, if any.
 * @returns nothing; the timer no longer fires.
 */
function clearHandshake(): void {
  if (handshakeTimer === undefined) return
  clearTimeout(handshakeTimer)
  handshakeTimer = undefined
}

/** Dispose a broken physical carrier once, then notify every affected logical stream. */
function failSocket(candidate: WebSocket, message: string): void {
  void message
  if (socket !== candidate) return
  clearHandshake()
  socket = undefined
  failStreams()
}

/** Send a received page frame immediately or retain it until the socket opens. */
function send(message: RemoteStreamClientMessage): void {
  const current = socket
  if (current === undefined || current.readyState === WebSocket.CONNECTING) {
    pending.push(message)
    ensureSocket()
    return
  }
  if (current.readyState === WebSocket.OPEN) {
    current.send(JSON.stringify(message))
    return
  }
  pending.push(message)
  ensureSocket()
}

/** Create the single physical socket when there is demand for a logical operation. */
function ensureSocket(): void {
  if (socket !== undefined && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return
  const candidate = new WebSocket(socketUrl())
  socket = candidate
  // A handshake that never settles must give the slot back: an armed timer
  // abandons this candidate so the next logical open starts a fresh one.
  clearHandshake()
  handshakeTimer = setTimeout(() => {
    handshakeTimer = undefined
    if (socket !== candidate) return
    failSocket(candidate, 'api gateway: Remote stream WebSocket handshake timed out')
    if (candidate.readyState === WebSocket.CONNECTING || candidate.readyState === WebSocket.CLOSING) {
      candidate.close(4003, 'handshake timed out')
    }
  }, HANDSHAKE_TIMEOUT_MS)
  candidate.addEventListener('open', () => {
    if (socket !== candidate) return
    clearHandshake()
    const queued = pending
    pending = []
    for (const message of queued) candidate.send(JSON.stringify(message))
  }, { once: true })
  candidate.addEventListener('message', (event: MessageEvent) => {
    if (socket !== candidate || typeof event.data !== 'string') return
    try {
      const frame = parseRemoteStreamServerMessage(event.data)
      const port = streams.get(frame.streamId)
      if (port === undefined) return
      port.postMessage(frame)
      if (frame.type === 'end' || frame.type === 'error') streams.delete(frame.streamId)
    } catch {
      failSocket(candidate, 'api gateway: invalid Remote stream frame')
      candidate.close(4002, 'invalid Remote stream frame')
    }
  })
  candidate.addEventListener('error', () => {
    failSocket(candidate, 'api gateway: Remote stream WebSocket failed')
  })
  candidate.addEventListener('close', () => {
    failSocket(candidate, 'api gateway: Remote stream WebSocket closed')
  }, { once: true })
}

/** Whether a page has permanently released its MessagePort. */
function isDisconnect(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'disconnect'
}

/** Whether a page wants the shared HMR event relay. */
function isHmrSubscribe(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hmr-subscribe'
}

/** Whether a page no longer wants the shared HMR event relay. */
function isHmrUnsubscribe(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hmr-unsubscribe'
}

/** Open the single SSE carrier while at least one page has an HMR subscription. */
function ensureHmrSource(): void {
  if (hmrSource !== undefined) return
  const source = new EventSource('plugins/events')
  hmrSource = source
  source.addEventListener('message', (event: MessageEvent<string>) => {
    if (hmrSource !== source) return
    for (const port of hmrPorts) port.postMessage({ type: 'hmr-event', data: event.data })
  })
}

/** Remove one HMR subscription and release the carrier with its last consumer. */
function unsubscribeHmr(port: MessagePort): void {
  hmrPorts.delete(port)
  if (hmrPorts.size !== 0 || hmrSource === undefined) return
  hmrSource.close()
  hmrSource = undefined
}

/** Cancel every logical stream owned by a departing document. */
function disconnect(port: MessagePort): void {
  ports.delete(port)
  unsubscribeHmr(port)
  for (const [streamId, owner] of streams) {
    if (owner !== port) continue
    streams.delete(streamId)
    const queued = pending.some(candidate => candidate.type === 'open' && candidate.streamId === streamId)
    pending = pending.filter(candidate => !(candidate.type === 'open' && candidate.streamId === streamId))
    if (!queued && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'cancel', streamId } satisfies RemoteStreamClientMessage))
    }
  }
}

/** Accept exactly the existing logical Remote stream frames from one document. */
function receive(port: MessagePort, value: unknown): void {
  if (isDisconnect(value)) {
    disconnect(port)
    return
  }
  if (isHmrSubscribe(value)) {
    hmrPorts.add(port)
    ensureHmrSource()
    return
  }
  if (isHmrUnsubscribe(value)) {
    unsubscribeHmr(port)
    return
  }
  let message: RemoteStreamClientMessage
  try {
    message = parseRemoteStreamClientMessage(JSON.stringify(value))
  } catch {
    return
  }
  if (message.type === 'open') {
    const existing = streams.get(message.streamId)
    if (existing !== undefined && existing !== port) return
    streams.set(message.streamId, port)
    send(message)
    return
  }
  if (streams.get(message.streamId) !== port) return
  streams.delete(message.streamId)
  pending = pending.filter(candidate => !(candidate.type === 'open' && candidate.streamId === message.streamId))
  send(message)
}

/** Attach one tab port to the shared physical mux. */
function connect(port: MessagePort): void {
  ports.add(port)
  port.addEventListener('message', (event) => { receive(port, event.data) })
  port.start()
}

self.addEventListener('connect', (event: Event) => {
  for (const port of (event as SharedWorkerConnectEvent).ports) connect(port)
})
