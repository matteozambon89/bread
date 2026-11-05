import { lookup } from 'node:dns/promises'
import type { LookupOptions } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { isPublicAddress } from './doc-load.js'
import { BreadError } from './types.js'

const MAX_REDIRECTS = 5
const MAX_BYTES = 100 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Public addresses that are still cloud metadata endpoints.
const METADATA_V4 = new Set(['100.100.100.200', '168.63.129.16'])

const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.goog'])

export interface TranscriptionAudioResponse {
  status: number
  location?: string
  body: Uint8Array
  mediaType?: string
}

export interface TranscriptionAudioDeps {
  resolve?: (hostname: string) => Promise<readonly string[]>
  request?: (url: URL, address: string, signal?: AbortSignal) => Promise<TranscriptionAudioResponse>
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void

// Bun calls lookup with `{ all: true }` and drops a bare (address, family) result
// ("Invalid IP address: undefined"). The array form is the pin that connects.
export function lookupPinned(address: string): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  const host = stripZone(stripBrackets(address))
  const family = isIP(host)
  if (family !== 4 && family !== 6) {
    throw new BreadError('Transcription refuses a non-public address.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address: host, family }])
    else callback(null, host, family)
  }
}

// Pipeline tests substitute DNS and the socket. Unset in production. Not a
// second downloader — explicit `deps` on a call still win.
let dependencyOverride: TranscriptionAudioDeps | undefined

export function setTranscriptionAudioDeps(deps: TranscriptionAudioDeps | undefined): void {
  dependencyOverride = deps
}

export async function downloadTranscriptionAudio(
  url: URL,
  issued: (href: string) => boolean | Promise<boolean>,
  opts?: { signal?: AbortSignal; deps?: TranscriptionAudioDeps },
): Promise<Uint8Array> {
  const response = await fetchHop(url, issued, opts?.deps ?? dependencyOverride, opts?.signal, 0)
  return response.body
}

async function fetchHop(
  url: URL,
  issued: (href: string) => boolean | Promise<boolean>,
  deps: TranscriptionAudioDeps | undefined,
  signal: AbortSignal | undefined,
  redirectsFollowed: number,
): Promise<TranscriptionAudioResponse> {
  if (redirectsFollowed > MAX_REDIRECTS) {
    throw new BreadError('Transcription stops after 5 redirect hops.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  await assertIssued(url, issued)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BreadError('Transcription only downloads http(s) URLs.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BreadError('Transcription refuses a URL with a username or password.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  const hostname = stripBrackets(url.hostname)
  if (hostname === '' || blockedHost(hostname)) {
    throw new BreadError('Transcription refuses a non-public address.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  const pinned = await pinnedAddress(hostname, deps)
  const request = deps?.request ?? productionRequest
  let response: TranscriptionAudioResponse
  try {
    response = await request(url, pinned, signal)
  } catch (err) {
    if (err instanceof BreadError) throw err
    throw new BreadError('Transcription could not fetch the audio.', 'TRANSCRIPTION_FETCH_FAILED')
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.location
    if (!location) {
      throw new BreadError('Transcription redirect is missing a Location.', 'TRANSCRIPTION_URL_BLOCKED')
    }
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new BreadError('Transcription redirect Location is not a URL.', 'TRANSCRIPTION_URL_BLOCKED')
    }
    return fetchHop(next, issued, deps, signal, redirectsFollowed + 1)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new BreadError(
      `Transcription audio fetch failed with HTTP ${response.status}.`,
      'TRANSCRIPTION_FETCH_FAILED',
    )
  }
  return response
}

async function assertIssued(url: URL, issued: (href: string) => boolean | Promise<boolean>): Promise<void> {
  let allowed = false
  try {
    allowed = await issued(url.href)
  } catch (err) {
    if (err instanceof BreadError) throw err
    allowed = false
  }
  if (!allowed) {
    throw new BreadError(
      'Transcription only downloads a URL the blob store issued.',
      'TRANSCRIPTION_URL_BLOCKED',
    )
  }
}

async function pinnedAddress(hostname: string, deps: TranscriptionAudioDeps | undefined): Promise<string> {
  const literal = ipLiteral(hostname)
  if (literal) {
    assertDownloadAddress(literal)
    return literal
  }
  const resolve = deps?.resolve ?? resolveHost
  let found: readonly string[]
  try {
    found = await resolve(hostname)
  } catch (err) {
    if (err instanceof BreadError) throw err
    throw new BreadError('Transcription could not resolve the host.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  if (found.length === 0) {
    throw new BreadError('Transcription could not resolve the host.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  for (const address of found) assertDownloadAddress(address)
  const pinned = found[0]
  if (pinned === undefined) {
    throw new BreadError('Transcription could not resolve the host.', 'TRANSCRIPTION_URL_BLOCKED')
  }
  return pinned
}

function assertDownloadAddress(address: string): void {
  if (!isPublicAddress(address) || isMetadataAddress(address)) {
    throw new BreadError('Transcription refuses a non-public address.', 'TRANSCRIPTION_URL_BLOCKED')
  }
}

function isMetadataAddress(address: string): boolean {
  const host = stripZone(stripBrackets(address)).toLowerCase()
  if (METADATA_V4.has(host)) return true
  return host === 'fd00:ec2::254'
}

function blockedHost(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.+$/, '')
  return BLOCKED_HOSTS.has(host)
}

async function resolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function productionRequest(
  url: URL,
  address: string,
  signal?: AbortSignal,
): Promise<TranscriptionAudioResponse> {
  assertDownloadAddress(address)
  const hostname = stripBrackets(url.hostname)
  const lookupFn = lookupPinned(address)
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BreadError('Transcription could not fetch the audio.', 'TRANSCRIPTION_FETCH_FAILED'))
      return
    }
    const req = transport(
      {
        method: 'GET',
        protocol: url.protocol,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        agent: false,
        rejectUnauthorized: true,
        headers: { host: url.host },
        lookup: lookupFn,
        signal,
      },
      (res) => {
        collectResponse(res).then(resolve, reject)
      },
    )
    req.on('error', () => {
      reject(new BreadError('Transcription could not fetch the audio.', 'TRANSCRIPTION_FETCH_FAILED'))
    })
    req.end()
  })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function collectResponse(res: IncomingMessage): Promise<TranscriptionAudioResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: BreadError) => {
      if (settled) return
      settled = true
      res.destroy()
      reject(err)
    }
    const done = (response: TranscriptionAudioResponse) => {
      if (settled) return
      settled = true
      resolve(response)
    }
    const status = res.statusCode ?? 0
    if (REDIRECT_STATUSES.has(status)) {
      const location = headerValue(res.headers.location)
      res.destroy()
      done({ status, ...(location ? { location } : {}), body: new Uint8Array() })
      return
    }
    const lengthValue = headerValue(res.headers['content-length'])
    if (lengthValue !== undefined) {
      const length = Number(lengthValue)
      if (Number.isFinite(length) && length > MAX_BYTES) {
        fail(new BreadError('Transcription audio is too large.', 'TRANSCRIPTION_FETCH_FAILED'))
        return
      }
    }
    const chunks: Buffer[] = []
    let total = 0
    res.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buf.length
      if (total > MAX_BYTES) {
        fail(new BreadError('Transcription audio is too large.', 'TRANSCRIPTION_FETCH_FAILED'))
        return
      }
      chunks.push(buf)
    })
    res.on('end', () => {
      const mediaType = headerValue(res.headers['content-type'])
      done({
        status,
        ...(mediaType ? { mediaType } : {}),
        body: new Uint8Array(Buffer.concat(chunks)),
      })
    })
    res.on('error', () => {
      fail(new BreadError('Transcription could not fetch the audio.', 'TRANSCRIPTION_FETCH_FAILED'))
    })
  })
}

function ipLiteral(hostname: string): string | null {
  const host = stripZone(hostname)
  return isIP(host) === 0 ? null : host
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']') && host.length >= 2) return host.slice(1, -1)
  return host
}

function stripZone(host: string): string {
  const zone = host.indexOf('%')
  return zone === -1 ? host : host.slice(0, zone)
}
