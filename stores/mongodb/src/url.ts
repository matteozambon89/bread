import { BreadError, isLoopbackHostname } from '@breadai/core'
import type { MongoClientOptions } from 'mongodb'

const FORBIDDEN_PARAMS = new Set([
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
  'tlsinsecure',
  'tlscertificatekeyfile',
  'tlscertificatekeyfilepassword',
  'tlscafile',
  'tlscrlfile',
  'sslallowinvalidcertificates',
  'sslallowinvalidhostnames',
  'sslpemkeyfile',
  'sslpemkeypassword',
  'sslcrlfile',
  'sslcafile',
])

const SCRAM = new Set(['SCRAM-SHA-1', 'SCRAM-SHA-256'])

export interface MongoEndpoint {
  url: string
  tls: boolean
  direct: boolean
}

function rejected(): never {
  throw new BreadError('MongoDB URL is not allowed.', 'STORE_URL_REJECTED')
}

function splitHosts(part: string): string[] {
  if (part.length === 0) rejected()
  const hosts: string[] = []
  let index = 0
  while (index < part.length) {
    if (part[index] === '[') {
      const end = part.indexOf(']', index)
      if (end === -1) rejected()
      hosts.push(part.slice(index, end + 1))
      index = end + 1
      if (part[index] === ':') {
        index += 1
        const start = index
        while (index < part.length && part[index] !== ',') index += 1
        if (index === start || !/^\d+$/.test(part.slice(start, index))) rejected()
      }
    } else {
      const comma = part.indexOf(',', index)
      const token = comma === -1 ? part.slice(index) : part.slice(index, comma)
      if (token.length === 0) rejected()
      const colon = token.lastIndexOf(':')
      const name = colon === -1 ? token : token.slice(0, colon)
      const port = colon === -1 ? '' : token.slice(colon + 1)
      if (name.length === 0) rejected()
      if (port !== '' && !/^\d+$/.test(port)) rejected()
      hosts.push(name)
      index = comma === -1 ? part.length : comma
    }
    if (index < part.length) {
      if (part[index] !== ',') rejected()
      index += 1
      if (index >= part.length) rejected()
    }
  }
  return hosts
}

export function resolveMongoUrl(raw: string | undefined, loopback: boolean): MongoEndpoint {
  if (raw === undefined || raw === '') {
    throw new BreadError(
      'MongoDB URL is missing. Pass url or set MONGODB_URL (mongodb://<host>/<db>).',
      'STORE_URL_MISSING',
    )
  }
  if (raw.length > 4096 || /[\s\u0000-\u001f]/.test(raw)) rejected()
  const scheme = /^(mongodb(?:\+srv)?):\/\/(.*)$/i.exec(raw)
  if (!scheme || scheme[1] === undefined || scheme[2] === undefined) rejected()
  const protocol = scheme[1].toLowerCase()
  let rest = scheme[2]
  const hash = rest.indexOf('#')
  if (hash !== -1) rest = rest.slice(0, hash)
  const queryAt = rest.indexOf('?')
  const query = queryAt === -1 ? '' : rest.slice(queryAt + 1)
  if (queryAt !== -1) rest = rest.slice(0, queryAt)
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '' : rest.slice(slash + 1)
  const database = path.split('/')[0] ?? ''
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) rejected()
  const at = authority.lastIndexOf('@')
  let hasAuth = false
  let hostList = authority
  if (at !== -1) {
    const userinfo = authority.slice(0, at)
    const colon = userinfo.indexOf(':')
    const username = colon === -1 ? userinfo : userinfo.slice(0, colon)
    hasAuth = username.length > 0
    hostList = authority.slice(at + 1)
  }
  const hosts = splitHosts(hostList)
  if (protocol === 'mongodb+srv' && hosts.length !== 1) rejected()

  const params = new URLSearchParams(query)
  let tlsFlag: boolean | undefined
  let mechanism: string | undefined
  for (const [key, value] of params) {
    const name = key.toLowerCase()
    if (FORBIDDEN_PARAMS.has(name)) rejected()
    if (name === 'tls' || name === 'ssl') {
      if (value === 'true' || value === '1') tlsFlag = true
      else if (value === 'false' || value === '0') tlsFlag = false
      else rejected()
    }
    if (name === 'authmechanism') mechanism = value
  }
  if (mechanism !== undefined && !SCRAM.has(mechanism.toUpperCase())) rejected()

  const tls = tlsFlag === undefined ? protocol === 'mongodb+srv' : tlsFlag
  const allLoopback = hosts.every((host) => isLoopbackHostname(host))
  if (loopback) {
    if (!allLoopback) rejected()
  } else if (!tls || !hasAuth) {
    rejected()
  }

  return {
    url: raw,
    tls,
    // Seed-list discovery can dial a non-loopback member. A loopback opt-in
    // stays on the one host named in the URL.
    direct: loopback && protocol === 'mongodb' && hosts.length === 1,
  }
}

export function mongoClientOptions(endpoint: MongoEndpoint, maxPoolSize: number): MongoClientOptions {
  const options: MongoClientOptions = {
    maxPoolSize,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  }
  if (maxPoolSize === 1) options.minPoolSize = 1
  if (endpoint.tls) options.tls = true
  if (endpoint.direct) options.directConnection = true
  return options
}
