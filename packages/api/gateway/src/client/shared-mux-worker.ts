/**
 * SharedWorker transport for the Gateway Remote multiplexing socket.
 *
 * Every connected document sends the existing Remote stream `open` and `cancel`
 * frames over its MessagePort. This Worker owns one physical WebSocket and
 * routes each Host frame back to the port that opened its stream id.
 */
import {
  REMOTE_STREAM_MUX_PATH,
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
  type RemoteStreamClientMessage,
} from '../stream-protocol.ts'

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[]
}

let socket: WebSocket | undefined
let pending: RemoteStreamClientMessage[] = []
const ports = new Set<MessagePort>()
const streams = new Map<string, MessagePort>()

/** Convert the Worker origin into the Gateway's same-origin WebSocket URL. */
function socketUrl(): string {
  const url = new URL(REMOTE_STREAM_MUX_PATH, self.location.origin)
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

/** Dispose a broken physical carrier once, then notify every affected logical stream. */
function failSocket(candidate: WebSocket, message: string): void {
  void message
  if (socket !== candidate) return
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
  candidate.addEventListener('open', () => {
    if (socket !== candidate) return
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

/** Cancel every logical stream owned by a departing document. */
function disconnect(port: MessagePort): void {
  ports.delete(port)
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
  port.addEventListener('message', event => { receive(port, event.data) })
  port.start()
}

self.addEventListener('connect', (event: Event) => {
  for (const port of (event as SharedWorkerConnectEvent).ports) connect(port)
})
