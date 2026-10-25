import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { verifiedPeer, type VerifiedPeerCertificate } from '@breadai/core'
import { listenMtls } from '@breadai/server'
import { issueMtlsCerts, requestMtls, type MtlsCerts } from './mtls-certs.ts'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      if (!addr || typeof addr === 'string') {
        probe.close()
        reject(new Error('expected TCP address'))
        return
      }
      const { port } = addr
      probe.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function failAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

interface HttpMessage {
  status: number
  body: string
}

function httpGet(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`
}

function takeHttpMessage(buf: Buffer): { message: HttpMessage; rest: Buffer } | undefined {
  const headerEnd = buf.indexOf('\r\n\r\n')
  if (headerEnd < 0) return undefined
  const header = buf.subarray(0, headerEnd).toString('utf8')
  const statusMatch = /^HTTP\/1\.[01] (\d+)/.exec(header)
  if (!statusMatch) throw new Error(`unparsed response: ${header}`)
  const status = Number(statusMatch[1])
  let offset = headerEnd + 4
  const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
  if (lengthMatch) {
    const size = Number(lengthMatch[1])
    if (buf.length < offset + size) return undefined
    return {
      message: { status, body: buf.subarray(offset, offset + size).toString('utf8') },
      rest: buf.subarray(offset + size),
    }
  }
  if (!/transfer-encoding:\s*chunked/i.test(header)) throw new Error(`unparsed response: ${header}`)
  let body = ''
  while (true) {
    const lineEnd = buf.indexOf('\r\n', offset)
    if (lineEnd < 0) return undefined
    const size = Number.parseInt(buf.subarray(offset, lineEnd).toString('utf8').split(';')[0] ?? '', 16)
    if (!Number.isFinite(size)) throw new Error(`bad chunk in response: ${header}`)
    offset = lineEnd + 2
    if (size === 0) {
      if (buf.length < offset + 2) return undefined
      if (buf.subarray(offset, offset + 2).toString('utf8') === '\r\n') {
        return { message: { status, body }, rest: buf.subarray(offset + 2) }
      }
      const trailerEnd = buf.indexOf('\r\n\r\n', offset)
      if (trailerEnd < 0) return undefined
      return { message: { status, body }, rest: buf.subarray(trailerEnd + 4) }
    }
    if (buf.length < offset + size + 2) return undefined
    body += buf.subarray(offset, offset + size).toString('utf8')
    offset += size + 2
  }
}

function httpMessages(socket: tls.TLSSocket): { next: () => Promise<HttpMessage> } {
  let buf = Buffer.alloc(0)
  const queued: HttpMessage[] = []
  let failed: Error | undefined
  let waiter: ((message: HttpMessage) => void) | undefined
  let rejectWaiter: ((err: Error) => void) | undefined

  const deliver = (message: HttpMessage) => {
    if (!waiter) {
      queued.push(message)
      return
    }
    const resolve = waiter
    waiter = undefined
    rejectWaiter = undefined
    resolve(message)
  }

  const fail = (err: Error) => {
    failed = err
    rejectWaiter?.(err)
    waiter = undefined
    rejectWaiter = undefined
  }

  socket.on('data', (chunk: Buffer) => {
    if (failed) return
    buf = Buffer.concat([buf, chunk])
    try {
      while (true) {
        const taken = takeHttpMessage(buf)
        if (!taken) return
        buf = taken.rest
        deliver(taken.message)
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })

  return {
    next() {
      if (failed && queued.length === 0) return Promise.reject(failed)
      const ready = queued.shift()
      if (ready) return Promise.resolve(ready)
      if (failed) return Promise.reject(failed)
      return new Promise((resolve, reject) => {
        waiter = resolve
        rejectWaiter = reject
      })
    },
  }
}

const nodeHeaderDeadlineDriver = `import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { listenMtls } from '../src/mtls.ts'
import { issueMtlsCerts } from './mtls-certs.ts'

const original = http.createServer.bind(http)
http.createServer = ((...args: Parameters<typeof http.createServer>) => {
  const server = original(...args)
  server.headersTimeout = 700
  server.requestTimeout = 5_000
  return server
}) as typeof http.createServer

const certs = await issueMtlsCerts()
const port = await new Promise<number>((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const addr = probe.address()
    if (!addr || typeof addr === 'string') {
      probe.close()
      reject(new Error('no port'))
      return
    }
    const found = addr.port
    probe.close((err) => (err ? reject(err) : resolve(found)))
  })
})
const listened = await listenMtls({
  fetch: () => new Response('no'),
  port,
  host: '127.0.0.1',
  tls: certs.server,
})
const socket = tls.connect({
  host: '127.0.0.1',
  port,
  ca: certs.ca,
  cert: certs.client.cert,
  key: certs.client.key,
  servername: 'localhost',
  rejectUnauthorized: true,
})
socket.on('error', () => {})
let data = ''
socket.on('data', (chunk: Buffer) => {
  data += chunk.toString('utf8')
})
try {
  await once(socket, 'secureConnect')
  const connectedAt = Date.now()
  await Promise.race([
    once(socket, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('silent socket stayed open')), 2_500)),
  ])
  const elapsed = Date.now() - connectedAt
  if (!data.startsWith('HTTP/1.1 408')) {
    console.error('missing 408', JSON.stringify(data), elapsed)
    process.exit(2)
  }
  if (elapsed < 450 || elapsed > 2_200) {
    console.error('deadline missed', elapsed)
    process.exit(3)
  }
  console.log('408 ' + elapsed)
} finally {
  socket.destroy()
  await listened.stop()
  await certs.cleanup()
}
`

const SPOOF_HEADERS = {
  'x-user-id': 'spoof',
  'x-forwarded-user': 'spoof',
  'x-forwarded-email': 'spoof@evil.example',
  'ssl-client-cert': 'spoof',
  'x-forwarded-client-cert': 'spoof',
}

describe('listenMtls', () => {
  test('does not import @hono/node-server and cannot skip verification', () => {
    const text = readFileSync(new URL('../src/mtls.ts', import.meta.url), 'utf8')
    expect(text).not.toMatch(/@hono\/node-server/)
    expect(text).toMatch(/requestCert:\s*true/)
    expect(text).toMatch(/rejectUnauthorized:\s*true/)
    expect(text).not.toMatch(/rejectUnauthorized:\s*(false|opts|options)/)
  })

  test('a partial or empty key, cert, or ca throws TLS_NOT_CONFIGURED before listen', async () => {
    const port = await freePort()
    const cases = [
      { key: '', cert: 'pem', ca: 'pem' },
      { key: 'pem', cert: '', ca: 'pem' },
      { key: 'pem', cert: 'pem', ca: '' },
      { cert: 'pem', ca: 'pem' },
      { key: 'pem', ca: 'pem' },
      { key: 'pem', cert: 'pem' },
      {},
    ]
    for (const tlsMaterial of cases) {
      await expect(
        listenMtls({
          fetch: () => new Response('no'),
          port,
          host: '127.0.0.1',
          tls: tlsMaterial,
        }),
      ).rejects.toMatchObject({ code: 'TLS_NOT_CONFIGURED' })
    }
    const probe = createNetServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })
})

describe('listenMtls with a verified client', () => {
  let certs: MtlsCerts

  beforeAll(async () => {
    certs = await issueMtlsCerts()
  })

  afterAll(async () => {
    await certs.cleanup()
  })

  async function serve(
    fetch: (request: Request) => Response | Promise<Response>,
    idleTimeout?: number,
  ): Promise<{ port: number; stop: () => Promise<void> }> {
    const port = await freePort()
    const listened = await listenMtls({
      fetch,
      port,
      host: '127.0.0.1',
      ...(idleTimeout !== undefined ? { idleTimeout } : {}),
      tls: certs.server,
    })
    return { port, stop: listened.stop }
  }

  test('attaches the leaf and does not trust or delete forwarded cert headers', async () => {
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    let stop: (() => Promise<void>) | undefined
    try {
      const served = await serve((request) =>
        Response.json({
          peer: verifiedPeer(request) ?? null,
          xUserId: request.headers.get('x-user-id'),
          forwardedUser: request.headers.get('x-forwarded-user'),
          forwardedEmail: request.headers.get('x-forwarded-email'),
          sslClientCert: request.headers.get('ssl-client-cert'),
          forwardedClientCert: request.headers.get('x-forwarded-client-cert'),
        }),
      )
      stop = served.stop
      const res = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        path: '/agents',
        headers: SPOOF_HEADERS,
      })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as {
        peer: VerifiedPeerCertificate
        xUserId: string
        forwardedUser: string
        forwardedEmail: string
        sslClientCert: string
        forwardedClientCert: string
      }
      expect(body.peer).toEqual({
        subjectCn: 'user-1',
        issuerCn: 'gateway-ca',
        fingerprint256: new X509Certificate(certs.client.cert).fingerprint256,
        organizationalUnits: ['acme'],
      })
      expect(body.xUserId).toBe('spoof')
      expect(body.forwardedUser).toBe('spoof')
      expect(body.forwardedEmail).toBe('spoof@evil.example')
      expect(body.sslClientCert).toBe('spoof')
      expect(body.forwardedClientCert).toBe('spoof')
      expect(lines.some((line) => line.includes(`https://127.0.0.1:${served.port}`))).toBe(true)
      expect(lines.some((line) => line.includes('http://'))).toBe(false)
    } finally {
      console.log = original
      await stop?.()
    }
  })

  test('a bare IPv6 Host reaches the route', async () => {
    const served = await serve((request) => {
      const url = new URL(request.url)
      return Response.json({ hostname: url.hostname, port: url.port })
    })
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      const messages = httpMessages(socket)
      socket.write('GET /agents HTTP/1.1\r\nHost: ::1\r\nConnection: close\r\n\r\n')
      const bare = await Promise.race([messages.next(), failAfter(2000, 'bare IPv6 host got no response')])
      expect(bare.status).toBe(200)
      expect(JSON.parse(bare.body)).toEqual({ hostname: '[::1]', port: '' })

      const named = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        path: '/agents',
        headers: { host: `localhost:${served.port}` },
      })
      expect(named.status).toBe(200)
      expect(JSON.parse(named.body)).toEqual({ hostname: 'localhost', port: String(served.port) })
    } finally {
      socket.destroy()
      await served.stop()
    }
  })

  test('absolute-form, scheme-relative, and backslash targets are 400 and do not reach fetch', async () => {
    let calls = 0
    const served = await serve((request) => {
      calls += 1
      const url = new URL(request.url)
      return Response.json({ hostname: url.hostname, pathname: url.pathname })
    })
    const call = (path: string, method = 'GET') =>
      requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        path,
        method,
      })
    try {
      const absolute = await call('http://evil.example/agents')
      const schemeRelative = await call('//evil.example/secret')
      const authority = await call('evil.example:443')
      const backslashHost = await call('/\\evil.example/agents')
      const backslashSlash = await call('/\\/evil.example/agents')
      const backslashUser = await call('/\\@evil.example/agents')
      expect(absolute.status).toBe(400)
      expect(schemeRelative.status).toBe(400)
      expect(authority.status).toBe(400)
      expect(backslashHost.status).toBe(400)
      expect(backslashSlash.status).toBe(400)
      expect(backslashUser.status).toBe(400)
      expect(calls).toBe(0)

      const origin = await call('/agents')
      expect(origin.status).toBe(200)
      expect(JSON.parse(origin.body)).toEqual({ hostname: '127.0.0.1', pathname: '/agents' })

      const asterisk = await call('*', 'OPTIONS')
      expect(asterisk.status).toBe(200)
      const star = JSON.parse(asterisk.body) as { hostname: string; pathname: string }
      expect(star.hostname).toBe('127.0.0.1')
      expect(star.pathname).toBe('/*')
      expect(calls).toBe(2)
    } finally {
      await served.stop()
    }
  })

  test('destroying the client aborts the request and cancels an unwritten body', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let sawSignal: (signal: AbortSignal) => void = () => {}
    const signalSeen = new Promise<AbortSignal>((resolve) => {
      sawSignal = resolve
    })
    let markCancelled = () => {}
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    const served = await serve(async (request) => {
      sawSignal(request.signal)
      await gate
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'))
          },
          cancel() {
            markCancelled()
          },
        }),
      )
    })
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      socket.write(httpGet('/hold'))
      const signal = await Promise.race([signalSeen, failAfter(2_000, 'handler did not start')])
      expect(signal.aborted).toBe(false)
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      socket.destroy()
      await Promise.race([aborted, failAfter(1_500, 'request signal stayed open')])
      expect(signal.aborted).toBe(true)
      release()
      await Promise.race([cancelled, failAfter(1_500, 'response body was not cancelled')])
    } finally {
      release()
      socket.destroy()
      await served.stop()
    }
  })

  test('a finished request body does not abort the handler', async () => {
    const served = await serve(async (request) => {
      const text = await request.text()
      await new Promise((resolve) => setTimeout(resolve, 40))
      return Response.json({ aborted: request.signal.aborted, text })
    })
    try {
      const res = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        method: 'POST',
        path: '/upload',
        body: 'hello',
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ aborted: false, text: 'hello' })
    } finally {
      await served.stop()
    }
  })

  test('attaches a cert with no OU and one with several', async () => {
    const served = await serve((request) => Response.json(verifiedPeer(request) ?? null))
    try {
      const solo = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.noOu.cert,
        key: certs.noOu.key,
      })
      expect(JSON.parse(solo.body)).toMatchObject({ subjectCn: 'solo', issuerCn: 'gateway-ca', organizationalUnits: [] })

      const multi = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.multiOu.cert,
        key: certs.multiOu.key,
      })
      const peer = JSON.parse(multi.body) as VerifiedPeerCertificate
      expect(peer.subjectCn).toBe('user-1')
      expect([...peer.organizationalUnits].sort()).toEqual(['acme', 'other'])
    } finally {
      await served.stop()
    }
  })

  test('a missing client certificate never reaches fetch', async () => {
    let calls = 0
    const served = await serve(() => {
      calls += 1
      return new Response('no')
    })
    try {
      await expect(
        Promise.race([
          requestMtls({ port: served.port, ca: certs.ca, path: '/agents' }),
          failAfter(2000, 'handshake did not fail'),
        ]),
      ).rejects.toBeInstanceOf(Error)
      expect(calls).toBe(0)
    } finally {
      await served.stop()
    }
  })

  test('a certificate from another CA never reaches fetch', async () => {
    let calls = 0
    const served = await serve(() => {
      calls += 1
      return new Response('no')
    })
    try {
      await expect(
        Promise.race([
          requestMtls({
            port: served.port,
            ca: certs.ca,
            cert: certs.foreign.cert,
            key: certs.foreign.key,
          }),
          failAfter(2000, 'handshake did not fail'),
        ]),
      ).rejects.toBeInstanceOf(Error)
      expect(calls).toBe(0)
    } finally {
      await served.stop()
    }
  })

  test('streams the request body before the client finishes it', async () => {
    let sawFirst: (chunk: string) => void = () => {}
    const first = new Promise<string>((resolve) => {
      sawFirst = resolve
    })
    const served = await serve(async (request) => {
      const reader = request.body?.getReader()
      if (!reader) return new Response('missing', { status: 500 })
      const decoder = new TextDecoder()
      const one = await reader.read()
      sawFirst(decoder.decode(one.value))
      let rest = ''
      while (true) {
        const next = await reader.read()
        if (next.done) break
        rest += decoder.decode(next.value)
      }
      return new Response(rest)
    })
    const req = https.request({
      host: '127.0.0.1',
      port: served.port,
      path: '/upload',
      method: 'POST',
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
      headers: { 'content-type': 'text/plain' },
    })
    try {
      req.flushHeaders()
      req.write('hello')
      const chunk = await Promise.race([first, failAfter(1500, 'request body was buffered until end')])
      expect(chunk).toBe('hello')
      const body = new Promise<string>((resolve, reject) => {
        req.on('response', (res) => {
          const chunks: Buffer[] = []
          res.on('data', (part: Buffer) => chunks.push(part))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          res.on('error', reject)
        })
        req.on('error', reject)
      })
      req.end('-world')
      expect(await body).toBe('-world')
    } finally {
      req.destroy()
      await served.stop()
    }
  })

  test('streams the response before the handler finishes it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const served = await serve(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('A'))
              await gate
              controller.enqueue(new TextEncoder().encode('B'))
              controller.close()
            },
          }),
        ),
    )
    const req = https.request({
      host: '127.0.0.1',
      port: served.port,
      path: '/stream',
      method: 'GET',
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    try {
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        req.on('response', resolve)
        req.on('error', reject)
        req.end()
      })
      const first = await Promise.race([
        new Promise<string>((resolve) => {
          res.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
        }),
        failAfter(1500, 'response body was buffered until the stream closed'),
      ])
      expect(first).toBe('A')
      release()
      const rest = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      })
      expect(first + rest).toBe('AB')
    } finally {
      release()
      req.destroy()
      await served.stop()
    }
  })

  test('on Node a silent post-handshake socket is closed with 408 at the header deadline', async () => {
    const testDir = fileURLToPath(new URL('.', import.meta.url))
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const entry = join(testDir, `.mtls-node-header-deadline-${process.pid}.ts`)
    const outDir = mkdtempSync(join(tmpdir(), 'mtls-node-deadline-'))
    const outfile = join(outDir, 'deadline.mjs')
    writeFileSync(entry, nodeHeaderDeadlineDriver)
    try {
      const built = spawnSync(
        process.execPath,
        ['build', entry, '--conditions', 'bread-source', '--target', 'node', '--format', 'esm', '--outfile', outfile],
        { cwd: root, encoding: 'utf8' },
      )
      if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr || built.stdout}`)
      const ran = spawnSync('node', [outfile], { encoding: 'utf8', timeout: 8_000 })
      if (ran.status !== 0) {
        throw new Error(`node deadline exit ${ran.status}: ${ran.stderr}\n${ran.stdout}`)
      }
      expect(ran.stdout).toMatch(/408 \d+/)
    } finally {
      rmSync(entry, { force: true })
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 15_000)

  test('a completed handshake with no HTTP bytes is closed without idleTimeout', async () => {
    const served = await serve(() => new Response('ok'))
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      const started = Date.now()
      let data = ''
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
      })
      await Promise.race([
        once(socket, 'close'),
        failAfter(90_000, 'silent handshake stayed open'),
      ])
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThan(45_000)
      expect(elapsed).toBeLessThan(90_000)
      expect(data.startsWith('HTTP/1.1 408')).toBe(true)
    } finally {
      socket.destroy()
      await served.stop()
    }
  }, 100_000)

  test('without idleTimeout a quiet handler and a finished response close after 10s', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markSlow = (_at: number) => {}
    const slowStarted = new Promise<number>((resolve) => {
      markSlow = resolve
    })
    const served = await serve(async (request) => {
      if (new URL(request.url).pathname === '/slow') {
        markSlow(Date.now())
        await gate
      }
      return new Response('ok')
    })
    const open = () =>
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port: served.port,
          ca: certs.ca,
          cert: certs.client.cert,
          key: certs.client.key,
          servername: 'localhost',
          rejectUnauthorized: true,
        })
        socket.on('error', () => {})
        socket.once('secureConnect', () => resolve(socket))
        socket.once('error', reject)
      })
    let idle: tls.TLSSocket | undefined
    let held: tls.TLSSocket | undefined
    try {
      idle = await open()
      held = await open()
      const idleMessages = httpMessages(idle)
      idle.write(httpGet('/once'))
      held.write(httpGet('/slow'))
      const slowAt = await Promise.race([slowStarted, failAfter(2_000, 'slow handler did not start')])
      const heldClosedAt = once(held, 'close').then(() => Date.now())
      const idleResponse = await Promise.race([
        idleMessages.next(),
        failAfter(2_000, 'idle response did not finish'),
      ])
      expect(idleResponse).toEqual({ status: 200, body: 'ok' })
      const finishedAt = Date.now()
      const idleClosedAt = once(idle, 'close').then(() => Date.now())
      const [idleClosed, heldClosed] = await Promise.all([
        Promise.race([idleClosedAt, failAfter(15_000, 'finished response stayed open')]),
        Promise.race([heldClosedAt, failAfter(15_000, 'quiet handler stayed open')]),
      ])
      const idleElapsed = idleClosed - finishedAt
      const heldElapsed = heldClosed - slowAt
      expect(idleElapsed).toBeGreaterThan(8_000)
      expect(idleElapsed).toBeLessThan(14_000)
      expect(heldElapsed).toBeGreaterThan(8_000)
      expect(heldElapsed).toBeLessThan(14_000)
    } finally {
      release()
      idle?.destroy()
      held?.destroy()
      await served.stop()
    }
  }, 30_000)

  test('idleTimeout still closes the socket after the response', async () => {
    const served = await serve(() => new Response('ok'), 1)
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      const messages = httpMessages(socket)
      socket.write(httpGet('/once'))
      const response = await Promise.race([messages.next(), failAfter(2_000, 'response did not finish')])
      expect(response).toEqual({ status: 200, body: 'ok' })
      const finishedAt = Date.now()
      await Promise.race([once(socket, 'close'), failAfter(4_000, 'idle socket stayed open after the response')])
      const elapsed = Date.now() - finishedAt
      expect(elapsed).toBeGreaterThan(500)
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      socket.destroy()
      await served.stop()
    }
  }, 8_000)

  test('idleTimeout 0 does not close a finished response at the keep-alive default', async () => {
    const served = await serve(() => new Response('ok'), 0)
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      const messages = httpMessages(socket)
      socket.write(httpGet('/once'))
      const response = await Promise.race([messages.next(), failAfter(2_000, 'response did not finish')])
      expect(response).toEqual({ status: 200, body: 'ok' })
      let closed = false
      socket.on('close', () => {
        closed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 7_000))
      expect(closed).toBe(false)
      expect(socket.destroyed).toBe(false)
    } finally {
      socket.destroy()
      await served.stop()
    }
  }, 12_000)

  test('idleTimeout becomes server.timeout in milliseconds', async () => {
    const served = await serve(() => new Response('ok'), 1)
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    try {
      await once(socket, 'secureConnect')
      const started = Date.now()
      await Promise.race([once(socket, 'close'), failAfter(3000, 'idle socket stayed open')])
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThan(500)
      expect(elapsed).toBeLessThan(3000)
    } finally {
      socket.destroy()
      await served.stop()
    }
  }, 8000)

  test('stop closes an open stream and a second stop ignores ERR_SERVER_NOT_RUNNING', async () => {
    let timer: ReturnType<typeof setInterval> | undefined
    const served = await serve(() => {
      const stream = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            try {
              controller.enqueue(new Uint8Array([120]))
            } catch {
              if (timer) clearInterval(timer)
            }
          }, 20)
        },
        cancel() {
          if (timer) clearInterval(timer)
        },
      })
      return new Response(stream)
    })
    const pending = requestMtls({
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      path: '/forever',
    }).catch(() => undefined)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      const result = await Promise.race([
        served.stop().then(() => 'stopped' as const),
        failAfter(1000, 'stop hung on an open stream'),
      ])
      expect(result).toBe('stopped')
      await served.stop()
      const rebound = await listenMtls({
        fetch: () => new Response('again'),
        port: served.port,
        host: '127.0.0.1',
        tls: certs.server,
      })
      const res = await requestMtls({
        port: served.port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        path: '/agents',
      })
      expect(res.status).toBe(200)
      expect(res.body).toBe('again')
      await rebound.stop()
    } finally {
      if (timer) clearInterval(timer)
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 200))])
    }
  })

  test('an unread body after the response does not time out the keep-alive socket', async () => {
    const port = await freePort()
    const headersTimeoutMs = 700
    const originalCreateServer = http.createServer
    http.createServer = ((...args: Parameters<typeof http.createServer>) => {
      http.createServer = originalCreateServer
      const server = originalCreateServer(...args)
      server.headersTimeout = headersTimeoutMs
      return server
    }) as typeof http.createServer
    let stop: (() => Promise<void>) | undefined
    let socket: tls.TLSSocket | undefined
    const payload = 'unread-body'
    try {
      const listened = await listenMtls({
        fetch: () => new Response('ok'),
        port,
        host: '127.0.0.1',
        idleTimeout: 0,
        tls: certs.server,
      })
      stop = listened.stop
      socket = tls.connect({
        host: '127.0.0.1',
        port,
        ca: certs.ca,
        cert: certs.client.cert,
        key: certs.client.key,
        servername: 'localhost',
        rejectUnauthorized: true,
      })
      socket.on('error', () => {})
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
      })
      await once(socket, 'secureConnect')
      const messages = httpMessages(socket)
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${payload.length}\r\nConnection: keep-alive\r\n\r\n`,
      )
      const posted = await Promise.race([messages.next(), failAfter(2_000, 'unread post got no response')])
      expect(posted).toEqual({ status: 200, body: 'ok' })
      for (const slice of [payload.slice(0, 4), payload.slice(4, 8), payload.slice(8)]) {
        socket.write(slice)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setTimeout(resolve, headersTimeoutMs + 1_500))
      expect(socket.destroyed).toBe(false)
      expect(received.includes('408')).toBe(false)
      socket.write(httpGet('/next'))
      const followed = await Promise.race([messages.next(), failAfter(2_000, 'follow-up get got no response')])
      expect(followed).toEqual({ status: 200, body: 'ok' })
    } finally {
      http.createServer = originalCreateServer
      socket?.destroy()
      await stop?.()
    }
  }, 10_000)

  test('several keep-alive requests on one connection do not exceed the close listener cap', async () => {
    const served = await serve(() => new Response('ok'), 0)
    const warnings: string[] = []
    const onWarning = (warning: Error) => {
      if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message)
    }
    process.on('warning', onWarning)
    const socket = tls.connect({
      host: '127.0.0.1',
      port: served.port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      servername: 'localhost',
      rejectUnauthorized: true,
    })
    socket.on('error', () => {})
    try {
      await once(socket, 'secureConnect')
      const messages = httpMessages(socket)
      for (let i = 0; i < 12; i++) {
        socket.write(httpGet('/once'))
        const response = await Promise.race([
          messages.next(),
          failAfter(2_000, 'keep-alive response did not finish'),
        ])
        expect(response).toEqual({ status: 200, body: 'ok' })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(warnings).toEqual([])
    } finally {
      process.off('warning', onWarning)
      socket.destroy()
      await served.stop()
    }
  })
})
