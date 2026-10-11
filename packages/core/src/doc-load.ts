import { lookup } from 'node:dns/promises'
import type { LookupOptions } from 'node:dns'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { resolve as resolvePath, sep } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { BreadError, type DocumentConfig } from './types.js'

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
]

type Eight = [number, number, number, number, number, number, number, number]

export interface DocHttpResponse {
  status: number
  location?: string
  body: string
}

export interface DocLoadDeps {
  resolve?: (hostname: string) => Promise<readonly string[]>
  request?: (url: URL, address: string) => Promise<DocHttpResponse>
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void

export function isPublicAddress(address: string): boolean {
  const host = stripZone(stripBrackets(address))
  if (isIP(host) === 4) return isPublicIPv4(host)
  if (isIP(host) === 6) {
    const groups = expandIPv6(host)
    if (!groups) return false
    const mapped = mappedIpv4(groups)
    if (mapped !== null) return isPublicIPv4(mapped)
    return isPublicIPv6(groups)
  }
  return false
}

// Only the address already checked for this hop. A later DNS answer must not rebind the socket.
export function pinnedLookup(address: string): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  if (!isPublicAddress(address)) {
    throw new BreadError('core_doc_load refuses a non-public address.', 'DOC_URL_BLOCKED')
  }
  const family = isIP(stripZone(stripBrackets(address)))
  if (family !== 4 && family !== 6) {
    throw new BreadError('core_doc_load refuses a non-public address.', 'DOC_URL_BLOCKED')
  }
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }])
    else callback(null, address, family)
  }
}

export async function loadDocumentSource(
  source: string,
  options?: DocumentConfig,
  deps?: DocLoadDeps,
): Promise<string> {
  const url = parseSourceUrl(source)
  if (url) return loadUrl(url, options, deps, 0)
  return loadFile(source, options?.fileRoot)
}

function parseSourceUrl(source: string): URL | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  // `C:\docs\a.txt` parses as a one-letter scheme and is a file path, not a URL.
  if (/^[a-zA-Z]:$/.test(url.protocol) && url.host === '') return null
  return url
}

async function loadUrl(
  url: URL,
  options: DocumentConfig | undefined,
  deps: DocLoadDeps | undefined,
  redirectsFollowed: number,
): Promise<string> {
  if (url.protocol !== 'https:') {
    throw new BreadError('core_doc_load only loads public https URLs.', 'DOC_URL_BLOCKED')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BreadError('core_doc_load rejects a URL with a username or password.', 'DOC_URL_BLOCKED')
  }
  const hostname = stripBrackets(url.hostname)
  if (!hostAllowed(hostname, options?.urlAllowlist)) {
    throw new BreadError('core_doc_load host is not in urlAllowlist.', 'DOC_URL_BLOCKED')
  }
  const pinned = await pinnedAddress(hostname, deps)
  const request = deps?.request ?? productionRequest
  let response: DocHttpResponse
  try {
    response = await request(url, pinned)
  } catch (err) {
    if (err instanceof BreadError) throw err
    throw new BreadError('core_doc_load could not fetch the document.', 'DOC_FETCH_FAILED')
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    if (redirectsFollowed >= MAX_REDIRECTS) {
      throw new BreadError('core_doc_load stops after 5 redirect hops.', 'DOC_URL_BLOCKED')
    }
    const location = response.location
    if (!location) {
      throw new BreadError('core_doc_load redirect is missing a Location.', 'DOC_URL_BLOCKED')
    }
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new BreadError('core_doc_load redirect Location is not a URL.', 'DOC_URL_BLOCKED')
    }
    return loadUrl(next, options, deps, redirectsFollowed + 1)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new BreadError(`Failed to fetch document: HTTP ${response.status}.`, 'DOC_FETCH_FAILED')
  }
  return response.body
}

function hostAllowed(hostname: string, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined) return true
  const host = hostname.toLowerCase()
  return allowlist.some((entry) => stripBrackets(entry).toLowerCase() === host)
}

async function pinnedAddress(hostname: string, deps: DocLoadDeps | undefined): Promise<string> {
  const literal = ipLiteral(hostname)
  if (literal) {
    if (!isPublicAddress(literal)) {
      throw new BreadError('core_doc_load refuses a non-public address.', 'DOC_URL_BLOCKED')
    }
    return literal
  }
  if (hostname === '' || hostname === '.' || hostname === '..') {
    throw new BreadError('core_doc_load only loads public https URLs.', 'DOC_URL_BLOCKED')
  }
  const resolve = deps?.resolve ?? resolveHost
  let found: readonly string[]
  try {
    found = await resolve(hostname)
  } catch (err) {
    if (err instanceof BreadError) throw err
    throw new BreadError('core_doc_load could not resolve the host.', 'DOC_URL_BLOCKED')
  }
  if (found.length === 0) {
    throw new BreadError('core_doc_load could not resolve the host.', 'DOC_URL_BLOCKED')
  }
  for (const address of found) {
    if (!isPublicAddress(address)) {
      throw new BreadError('core_doc_load refuses a non-public address.', 'DOC_URL_BLOCKED')
    }
  }
  const pinned = found[0]
  if (pinned === undefined) {
    throw new BreadError('core_doc_load could not resolve the host.', 'DOC_URL_BLOCKED')
  }
  return pinned
}

async function resolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function productionRequest(url: URL, address: string): Promise<DocHttpResponse> {
  const hostname = stripBrackets(url.hostname)
  const lookupFn = pinnedLookup(address)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'GET',
        protocol: 'https:',
        hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        agent: false,
        rejectUnauthorized: true,
        headers: { host: url.host },
        lookup: lookupFn,
      },
      (res) => {
        collectResponse(res).then(resolve, reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function collectResponse(res: IncomingMessage): Promise<DocHttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    res.on('end', () => {
      const raw = res.headers.location
      const location = Array.isArray(raw) ? raw[0] : raw
      resolve({
        status: res.statusCode ?? 0,
        ...(location ? { location } : {}),
        body: Buffer.concat(chunks).toString('utf8'),
      })
    })
    res.on('error', reject)
  })
}

async function loadFile(source: string, fileRoot: string | undefined): Promise<string> {
  if (!fileRoot) {
    throw new BreadError(
      'core_doc_load does not read local files unless fileRoot is set.',
      'DOC_FILE_DISABLED',
    )
  }
  let rootReal: string
  try {
    rootReal = await realpath(resolvePath(fileRoot))
    const rootStat = await stat(rootReal)
    if (!rootStat.isDirectory()) {
      throw new BreadError('core_doc_load fileRoot must be a readable directory.', 'DOC_FILE_DISABLED')
    }
  } catch (err) {
    if (err instanceof BreadError) throw err
    throw new BreadError('core_doc_load fileRoot must be a readable directory.', 'DOC_FILE_DISABLED')
  }
  const candidate = resolvePath(fileRoot, source)
  let candidateReal: string
  try {
    candidateReal = await realpath(candidate)
  } catch {
    throw new BreadError('core_doc_load could not read a file inside fileRoot.', 'DOC_FILE_ESCAPE')
  }
  // `root-extra` must not match a root named `root`.
  if (!isInsideRoot(rootReal, candidateReal)) {
    throw new BreadError('core_doc_load refuses a path outside fileRoot.', 'DOC_FILE_ESCAPE')
  }
  // Re-open the real path so a symlink swapped in after the check is not followed.
  const flags =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY
  try {
    const handle = await open(candidateReal, flags)
    try {
      return await handle.readFile({ encoding: 'utf8' })
    } finally {
      await handle.close()
    }
  } catch {
    throw new BreadError('core_doc_load could not read a file inside fileRoot.', 'DOC_FILE_ESCAPE')
  }
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  if (candidateReal === rootReal) return true
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  return candidateReal.startsWith(prefix)
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

function isPublicIPv4(host: string): boolean {
  const ip = ipv4ToInt(host)
  if (ip === null) return false
  for (const [base, bits] of IPV4_BLOCKS) {
    const block = ipv4ToInt(base)
    if (block === null) return false
    if (inCidr(ip, block, bits)) return false
  }
  return true
}

function isPublicIPv6(groups: Eight): boolean {
  if (groups.every((part) => part === 0)) return false
  if (groups[7] === 1 && groups.slice(0, 7).every((part) => part === 0)) return false
  const high = groups[0]
  const second = groups[1]
  if ((high & 0xfe00) === 0xfc00) return false
  if ((high & 0xffc0) === 0xfe80) return false
  if ((high & 0xff00) === 0xff00) return false
  if (high === 0x2001 && second === 0x0db8) return false
  return true
}

function mappedIpv4(groups: Eight): string | null {
  if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0 || groups[4] !== 0 || groups[5] !== 0xffff) {
    return null
  }
  const hi = groups[6]
  const lo = groups[7]
  return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`
}

function expandIPv6(input: string): Eight | null {
  let address = stripZone(input)
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    if (lastColon < 0) return null
    const v4 = ipv4ToInt(address.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = (v4 >>> 16) & 0xffff
    const lo = v4 & 0xffff
    address = `${address.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }
  const halves = address.split('::')
  if (halves.length > 2) return null
  const headRaw = halves[0]
  const tailRaw = halves[1]
  const head = headRaw === undefined || headRaw === '' ? [] : headRaw.split(':')
  const tail = halves.length === 1 || tailRaw === undefined || tailRaw === '' ? [] : tailRaw.split(':')
  let parts: string[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    parts = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    parts = [...head, ...Array<string>(missing).fill('0'), ...tail]
  }
  if (parts.length !== 8) return null
  const groups: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  if (!isEight(groups)) return null
  return groups
}

function isEight(groups: number[]): groups is Eight {
  return groups.length === 8
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function inCidr(ip: number, base: number, bits: number): boolean {
  const shift = 32 - bits
  const mask = shift === 0 ? 0xffffffff : (0xffffffff << shift) >>> 0
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0)
}

