import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import tls from 'node:tls'
import type { Server as TlsServer, TLSSocket } from 'node:tls'
import { attachVerifiedPeer, BreadError, type VerifiedPeerCertificate } from '@breadai/core'

export interface TlsPem {
  key: string
  cert: string
  ca: string
}

export interface ListenMtlsOptions {
  fetch: (request: Request) => Response | Promise<Response>
  port: number
  host: string
  /**
   * Seconds of socket inactivity, same as Bun.serve `idleTimeout`.
   * Omit for that 10s default. `0` disables it. Not the header or request deadline.
   */
  idleTimeout?: number
  tls: Partial<TlsPem>
}

const NO_BODY = new Set(['GET', 'HEAD'])
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade'])

/**
 * @internal Listen with a required client certificate. Runtime adapters call
 * this when `config.server.tls` is set. `startServer` and `startServerNode`
 * stay the public entry points.
 */
export async function listenMtls(options: ListenMtlsOptions): Promise<{ stop: () => Promise<void> }> {
  const pem = requirePem(options.tls)
  // Bun.serve defaults to 10s. 0 disables the gap instead of arming Node's 5s+1s.
  const idleMs = (options.idleTimeout === undefined ? 10 : options.idleTimeout) * 1000

  // Bun.serve exposes no peer certificate, and a Bun https socket still has no
  // getPeerCertificate. node:tls is the listener that can prove the client.
  // requestCert and rejectUnauthorized stay on — there is no skip switch.
  const tlsServer = tls.createServer({
    key: pem.key,
    cert: pem.cert,
    ca: pem.ca,
    requestCert: true,
    rejectUnauthorized: true,
  })
  let deadlines: DeadlineTracker | undefined
  const httpServer = http.createServer((req, res) => {
    deadlines?.noteRequest(req, res)
    const socket = req.socket
    if (socket) armSocketIdle(socket, idleMs)
    // resOnFinish replaces the socket timer after the response. Put the same gap back,
    // including 0, or Node leaves its default ~6s keep-alive in place.
    res.on('finish', () => {
      const reapply = () => {
        if (!socket || socket.destroyed) return
        socket.setTimeout(idleMs)
      }
      reapply()
      process.nextTick(reapply)
    })
    void handleRequest(req, res, options.fetch)
  })
  httpServer.timeout = idleMs
  httpServer.keepAliveTimeout = idleMs
  httpServer.keepAliveTimeoutBuffer = 0

  // This server never binds. 'listening' starts Node's connection sweep, but
  // that list does not apply header deadlines to sockets passed to emit('connection')
  // until the next 30s pass. Arm our own tracker for every one of those sockets.
  httpServer.emit('listening')
  deadlines = createDeadlineTracker(httpServer)

  tlsServer.on('tlsClientError', () => {})
  tlsServer.on('secureConnection', (socket) => {
    trackSocket(tlsServer, socket)
    deadlines?.watch(socket)
    httpServer.emit('connection', socket)
    if (options.idleTimeout !== undefined) {
      // An explicit idle timeout covers the handshake too. Each byte resets it.
      armSocketIdle(socket, idleMs)
      return
    }
    // Node copies server.timeout onto the socket at connection. Clear it only
    // while the header tracker is active, or a silent handshake never ends.
    if (deadlines) socket.setTimeout(0)
  })

  const stop = async () => {
    deadlines?.stop()
    await closeServers(tlsServer, httpServer)
  }

  try {
    await listen(tlsServer, options.port, options.host)
  } catch (err) {
    await stop()
    throw err
  }

  console.log(`[bread] Listening on https://${options.host}:${options.port}`)

  return { stop }
}

function requirePem(tls: Partial<TlsPem>): TlsPem {
  const { key, cert, ca } = tls
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    typeof cert !== 'string' ||
    cert.length === 0 ||
    typeof ca !== 'string' ||
    ca.length === 0
  ) {
    throw new BreadError(
      'TLS is not configured. Set `server.tls.key`, `server.tls.cert`, and `server.tls.ca` to PEM ' +
        'contents. Paths are not read, and verification cannot be disabled.',
      'TLS_NOT_CONFIGURED',
    )
  }
  return { key, cert, ca }
}

function listen(server: TlsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const idleDestroyArmed = new WeakSet<Socket>()

function armSocketIdle(socket: Socket, idleMs: number): void {
  socket.setTimeout(idleMs)
  if (idleMs <= 0 || idleDestroyArmed.has(socket)) return
  idleDestroyArmed.add(socket)
  socket.on('timeout', () => {
    if (!socket.destroyed) socket.destroy()
  })
}

const openSockets = new WeakMap<TlsServer, Set<tls.TLSSocket>>()

function trackSocket(server: TlsServer, socket: tls.TLSSocket): void {
  let sockets = openSockets.get(server)
  if (!sockets) {
    sockets = new Set()
    openSockets.set(server, sockets)
  }
  sockets.add(socket)
  socket.on('close', () => sockets?.delete(socket))
}

async function closeServers(tlsServer: TlsServer, httpServer: http.Server): Promise<void> {
  for (const socket of [...(openSockets.get(tlsServer) ?? [])]) socket.destroy()
  await closeQuiet(tlsServer)
  // close() clears the connections-checking interval even though listen() never ran.
  await closeQuiet(httpServer, true)
}

function closeQuiet(server: TlsServer | http.Server, force = false): Promise<void> {
  // Bun's node:tls server omits closeAllConnections. Node's http.Server has it.
  const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections
  if (typeof closeAll === 'function') closeAll.call(server)
  if (!force && server.listening === false) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err)
      else resolve()
    })
  })
}

const REQUEST_TIMEOUT_RESPONSE = Buffer.from(
  'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n',
)

interface MessageClock {
  startedAt: number
  headersDone: boolean
  done: boolean
}

interface TrackedSocket {
  generation: number
  clock: MessageClock
  timer?: ReturnType<typeof setTimeout> | undefined
  request?: IncomingMessage
}

interface DeadlineTracker {
  watch(socket: TLSSocket): void
  noteRequest(req: IncomingMessage, res: ServerResponse): void
  stop(): void
}

function remainingMs(server: http.Server, clock: MessageClock, now: number): number | undefined {
  if (clock.done) return undefined
  const elapsed = now - clock.startedAt
  const waits: number[] = []
  if (!clock.headersDone && server.headersTimeout > 0) waits.push(server.headersTimeout - elapsed)
  if (server.requestTimeout > 0) waits.push(server.requestTimeout - elapsed)
  if (waits.length === 0) return undefined
  return Math.min(...waits)
}

function failRequestTimeout(socket: TLSSocket): void {
  if (socket.destroyed) return
  const response = socket as TLSSocket & { _httpMessage?: { headersSent?: boolean } }
  if (!response._httpMessage?.headersSent && socket.writable && !socket.writableEnded) {
    try {
      socket.write(REQUEST_TIMEOUT_RESPONSE)
    } catch {
      // The peer can reset while the deadline fires.
    }
  }
  socket.destroy()
}

function createDeadlineTracker(server: http.Server): DeadlineTracker {
  const tracked = new Map<TLSSocket, TrackedSocket>()

  function arm(socket: TLSSocket): void {
    const entry = tracked.get(socket)
    if (!entry || entry.clock.done || socket.destroyed) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    const wait = remainingMs(server, entry.clock, Date.now())
    if (wait === undefined) return
    if (wait <= 0) {
      failRequestTimeout(socket)
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      arm(socket)
    }, wait)
    entry.timer.unref?.()
  }

  return {
    watch(socket) {
      tracked.set(socket, {
        generation: 0,
        clock: { startedAt: Date.now(), headersDone: false, done: false },
      })
      socket.on('close', () => {
        const current = tracked.get(socket)
        if (!current) return
        if (current.timer) clearTimeout(current.timer)
        tracked.delete(socket)
      })
      // A finished response leaves the clock done. Unread body bytes are not the
      // next request, so they must not arm headersTimeout on the keep-alive socket.
      socket.on('data', () => {
        const current = tracked.get(socket)
        if (!current?.clock.done) return
        const request = current.request
        if (request && !request.complete && !request.readableEnded) return
        current.generation += 1
        current.clock = { startedAt: Date.now(), headersDone: false, done: false }
        arm(socket)
      })
      arm(socket)
    },
    noteRequest(req, res) {
      const socket = req.socket as TLSSocket | null
      if (!socket) return
      const entry = tracked.get(socket)
      if (!entry) return
      entry.request = req
      if (entry.clock.done) {
        entry.clock = { startedAt: Date.now(), headersDone: false, done: false }
      }
      entry.generation += 1
      const generation = entry.generation
      entry.clock.headersDone = true
      const finish = () => {
        // A late end from the previous message must not cancel the next deadline.
        if (tracked.get(socket) !== entry || entry.generation !== generation) return
        entry.clock.done = true
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = undefined
        socket.off('data', markIfComplete)
      }
      const markIfComplete = () => {
        // complete is set when the request message is parsed. A paused empty
        // body may never emit 'end', and the handler can still be running.
        if (req.complete || req.readableEnded) finish()
      }
      // A response can finish while the body is still unread. Stop the request
      // deadline then; the idle timer covers the quiet gap afterward.
      res.on('finish', finish)
      if (req.complete || req.readableEnded) {
        finish()
        return
      }
      req.on('end', finish)
      req.on('aborted', finish)
      socket.on('data', markIfComplete)
      process.nextTick(markIfComplete)
      arm(socket)
    },
    stop() {
      for (const entry of tracked.values()) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = undefined
      }
      tracked.clear()
    },
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  fetchApp: ListenMtlsOptions['fetch'],
): Promise<void> {
  const controller = new AbortController()
  const abortIfClientGone = () => {
    if (!controller.signal.aborted && clientDisconnected(req, res)) controller.abort()
  }
  // A finished request body also emits close while the client is still waiting.
  req.on('close', abortIfClientGone)
  res.on('close', abortIfClientGone)
  req.socket?.on('close', abortIfClientGone)
  abortIfClientGone()

  try {
    const target = req.url ?? ''
    const url = acceptedRequestUrl(target, requestHost(req))
    if (!url) {
      writeBadRequest(res)
      return
    }
    const response = await fetchApp(toFetchRequest(req, url, controller.signal))
    if (responseSocketGone(req, res) || controller.signal.aborted) {
      await cancelResponseBody(response)
      return
    }
    await writeResponse(res, response)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (
      res.destroyed ||
      res.writableEnded ||
      code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE'
    ) {
      if (!res.writableEnded) res.destroy()
      return
    }
    console.error('[bread] mTLS request failed:', err)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }))
  } finally {
    req.off('close', abortIfClientGone)
    res.off('close', abortIfClientGone)
    req.socket?.off('close', abortIfClientGone)
  }
}

function clientDisconnected(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.socket?.destroyed) return true
  return !res.writableFinished && (res.destroyed || res.writableEnded)
}

function responseSocketGone(req: IncomingMessage, res: ServerResponse): boolean {
  return res.writableEnded || res.destroyed || req.socket?.destroyed === true
}

function isAcceptedRequestTarget(target: string): boolean {
  if (target === '*') return true
  // Origin-form only. Absolute-form and scheme-relative targets replace the listener origin.
  // The URL parser maps `\` to `/`, so /\evil.example is scheme-relative too.
  return target.startsWith('/') && !target.startsWith('//') && !target.includes('\\')
}

function requestHost(req: IncomingMessage): string {
  const hostHeader = req.headers.host
  return typeof hostHeader === 'string' && hostHeader.length > 0 ? hostHeader : 'localhost'
}

function acceptedRequestUrl(target: string, host: string): URL | undefined {
  if (!isAcceptedRequestTarget(target)) return undefined
  try {
    const origin = requestOrigin(host)
    const url = new URL(target, origin)
    // A target can still retarget the request after the slash check.
    if (url.origin !== new URL(origin).origin) return undefined
    return url
  } catch {
    return undefined
  }
}

function writeBadRequest(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(400, { connection: 'close', 'content-type': 'text/plain; charset=utf-8' })
  res.end('Bad Request')
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    await response.body.cancel()
  } catch {
    // The peer already went away.
  }
}

function toFetchRequest(req: IncomingMessage, url: URL, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.append(name, value)
    }
  }

  const method = req.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal }
  if (!NO_BODY.has(method)) {
    init.body = Readable.toWeb(req) as WebReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  const request = new Request(url.toString(), init)
  const peer = leafFromSocket(req.socket)
  if (peer) attachVerifiedPeer(request, peer)
  return request
}

function requestOrigin(host: string): string {
  if (host.startsWith('[')) return `https://${host}`
  const colon = host.indexOf(':')
  // One colon is host:port. A bare IPv6 address has at least two, and URL requires brackets.
  if (colon === -1 || host.indexOf(':', colon + 1) === -1) return `https://${host}`
  return `https://[${host}]`
}

function leafFromSocket(socket: IncomingMessage['socket']): VerifiedPeerCertificate | undefined {
  if (!socket || !('getPeerCertificate' in socket) || typeof socket.getPeerCertificate !== 'function') {
    return undefined
  }
  const tlsSocket = socket as TLSSocket
  if (tlsSocket.authorized !== true) return undefined
  let cert: RawPeer
  try {
    cert = tlsSocket.getPeerCertificate(false) as RawPeer
  } catch {
    return undefined
  }
  if (!cert || Object.keys(cert).length === 0) return undefined
  const subjectCn = oneCn(cert.subject?.CN)
  const issuerCn = oneCn(cert.issuer?.CN)
  if (!subjectCn || !issuerCn) return undefined
  return {
    subjectCn,
    issuerCn,
    fingerprint256: typeof cert.fingerprint256 === 'string' ? cert.fingerprint256 : '',
    organizationalUnits: names(cert.subject?.OU),
  }
}

interface RawPeer {
  subject?: { CN?: unknown; OU?: unknown }
  issuer?: { CN?: unknown }
  fingerprint256?: unknown
}

function names(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

function oneCn(value: unknown): string | undefined {
  const found = names(value).filter((name) => name.length > 0)
  if (found.length !== 1) return undefined
  return found[0]
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return
    const existing = headers[key]
    if (existing === undefined) headers[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else headers[key] = [existing, value]
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), res)
}
