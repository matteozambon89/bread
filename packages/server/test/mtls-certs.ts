import { spawn } from 'node:child_process'
import https from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PemPair {
  key: string
  cert: string
}

export interface MtlsCerts {
  ca: string
  issuerCn: 'gateway-ca'
  server: { key: string; cert: string; ca: string }
  /** Subject CN user-1, one OU acme. */
  client: PemPair
  /** Subject CN solo, no OU. */
  noOu: PemPair
  /** Subject CN user-1, OU acme and OU other. */
  multiOu: PemPair
  /** Signed by a different CA. */
  foreign: PemPair
  cleanup: () => Promise<void>
}

const CLIENT_EXT = 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n'
const SERVER_EXT = 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n'

function openssl(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    const errors: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`openssl ${args.join(' ')} exited ${code}: ${Buffer.concat(errors).toString()}`))
    })
  })
}

async function sign(dir: string, name: string, subject: string, ext: string, caName = 'ca'): Promise<void> {
  await openssl(
    ['req', '-newkey', 'rsa:2048', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-nodes', '-subj', subject],
    dir,
  )
  await writeFile(join(dir, `${name}.ext`), ext)
  await openssl(
    [
      'x509', '-req', '-in', `${name}.csr`,
      '-CA', `${caName}.crt`, '-CAkey', `${caName}.key`, '-CAcreateserial',
      '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`,
    ],
    dir,
  )
}

async function readPem(dir: string, name: string): Promise<string> {
  return readFile(join(dir, name), 'utf8')
}

export async function issueMtlsCerts(): Promise<MtlsCerts> {
  const dir = await mkdtemp(join(tmpdir(), 'bread-mtls-'))
  await openssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-nodes', '-subj', '/CN=gateway-ca'],
    dir,
  )
  await sign(dir, 'server', '/CN=localhost', SERVER_EXT)
  await sign(dir, 'client', '/CN=user-1/OU=acme', CLIENT_EXT)
  await sign(dir, 'no-ou', '/CN=solo', CLIENT_EXT)
  await sign(dir, 'multi', '/CN=user-1/OU=acme/OU=other', CLIENT_EXT)
  await openssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'other.key', '-out', 'other.crt', '-days', '1', '-nodes', '-subj', '/CN=other-ca'],
    dir,
  )
  await sign(dir, 'foreign', '/CN=spoof/OU=forged', CLIENT_EXT, 'other')

  const ca = await readPem(dir, 'ca.crt')
  const serverKey = await readPem(dir, 'server.key')
  const serverCert = await readPem(dir, 'server.crt')
  return {
    ca,
    issuerCn: 'gateway-ca',
    server: { key: serverKey, cert: serverCert, ca },
    client: { key: await readPem(dir, 'client.key'), cert: await readPem(dir, 'client.crt') },
    noOu: { key: await readPem(dir, 'no-ou.key'), cert: await readPem(dir, 'no-ou.crt') },
    multiOu: { key: await readPem(dir, 'multi.key'), cert: await readPem(dir, 'multi.crt') },
    foreign: { key: await readPem(dir, 'foreign.key'), cert: await readPem(dir, 'foreign.crt') },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export interface MtlsRequest {
  port: number
  ca: string
  cert?: string
  key?: string
  path?: string
  method?: string
  body?: string
  headers?: Record<string, string>
}

export function requestMtls(opts: MtlsRequest): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path ?? '/',
        method: opts.method ?? 'GET',
        ca: opts.ca,
        ...(opts.cert !== undefined ? { cert: opts.cert } : {}),
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        servername: 'localhost',
        rejectUnauthorized: true,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.end(opts.body)
    else req.end()
  })
}
