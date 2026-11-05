import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, test } from 'bun:test'
import { BreadError } from '../src/types.js'
import {
  downloadTranscriptionAudio,
  lookupPinned,
  type TranscriptionAudioDeps,
} from '../src/transcription-audio.js'

const SECRET = 'X-Amz-Signature=supersecret'

function audioUrl(href = `https://cdn.example/clip.mp3?${SECRET}`): URL {
  return new URL(href)
}

describe('downloadTranscriptionAudio', () => {
  test('does not resolve or request a URL the blob store did not issue', async () => {
    let resolved = false
    let requested = false
    const deps: TranscriptionAudioDeps = {
      resolve: async () => {
        resolved = true
        return ['1.1.1.1']
      },
      request: async () => {
        requested = true
        return { status: 200, body: new Uint8Array([1]) }
      },
    }
    const err = await downloadTranscriptionAudio(audioUrl(), async () => false, { deps }).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(BreadError)
    expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
    expect((err as Error).message).not.toContain(SECRET)
    expect((err as Error).message).not.toContain('cdn.example')
    expect(resolved).toBe(false)
    expect(requested).toBe(false)
  })

  test('does not connect to a link-local literal or a metadata address', async () => {
    const requested: string[] = []
    const deps: TranscriptionAudioDeps = {
      resolve: async () => ['1.1.1.1'],
      request: async (url) => {
        requested.push(url.hostname)
        return { status: 200, body: new Uint8Array([1]) }
      },
    }
    for (const href of [
      'https://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://127.0.0.1/clip.mp3',
      'http://10.0.0.8/clip.mp3',
    ]) {
      const err = await downloadTranscriptionAudio(new URL(href), async () => true, { deps }).catch((error: unknown) => error)
      expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
      expect((err as Error).message).not.toContain('169.254.169.254')
    }
    expect(requested).toEqual([])
  })

  test('does not connect when a hostname resolves to a private or metadata address', async () => {
    const requested: string[] = []
    const deps: TranscriptionAudioDeps = {
      resolve: async (hostname) => {
        if (hostname === '169.254.169.254.nip.io') return ['169.254.169.254']
        if (hostname === 'mixed.example') return ['8.8.8.8', '10.1.1.1']
        return ['100.100.100.200']
      },
      request: async (url) => {
        requested.push(url.hostname)
        return { status: 200, body: new Uint8Array([1]) }
      },
    }
    for (const host of ['169.254.169.254.nip.io', 'mixed.example', 'meta.example']) {
      const err = await downloadTranscriptionAudio(new URL(`https://${host}/a`), async () => true, { deps }).catch(
        (error: unknown) => error,
      )
      expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
    }
    expect(requested).toEqual([])
  })

  test('pins the first public address and rechecks every redirect hop', async () => {
    const requested: Array<{ host: string; address: string }> = []
    const deps: TranscriptionAudioDeps = {
      resolve: async (hostname) => (hostname === 'cdn.example' ? ['8.8.8.8', '1.1.1.1'] : ['9.9.9.9']),
      request: async (url, address) => {
        requested.push({ host: url.hostname, address })
        if (url.hostname === 'cdn.example') {
          return { status: 302, location: 'https://audio.example/clip.mp3', body: new Uint8Array() }
        }
        return { status: 200, body: new Uint8Array([7, 7]) }
      },
    }
    const body = await downloadTranscriptionAudio(new URL('https://cdn.example/a'), async () => true, { deps })
    expect(Array.from(body)).toEqual([7, 7])
    expect(requested).toEqual([
      { host: 'cdn.example', address: '8.8.8.8' },
      { host: 'audio.example', address: '9.9.9.9' },
    ])
  })

  test('does not connect to a redirect that resolves to a link-local address', async () => {
    const requested: string[] = []
    const deps: TranscriptionAudioDeps = {
      resolve: async (hostname) => (hostname === 'metadata.internal' ? ['169.254.169.254'] : ['8.8.8.8']),
      request: async (url) => {
        requested.push(url.hostname)
        return { status: 307, location: 'https://metadata.internal/latest', body: new Uint8Array() }
      },
    }
    const err = await downloadTranscriptionAudio(new URL('https://cdn.example/a'), async () => true, { deps }).catch(
      (error: unknown) => error,
    )
    expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
    expect(requested).toEqual(['cdn.example'])
  })

  test('does not follow a redirect the blob store did not issue', async () => {
    const requested: string[] = []
    const deps: TranscriptionAudioDeps = {
      resolve: async () => ['8.8.8.8'],
      request: async (url) => {
        requested.push(url.href)
        return { status: 302, location: `https://evil.example/stolen?${SECRET}`, body: new Uint8Array() }
      },
    }
    const err = await downloadTranscriptionAudio(new URL('https://cdn.example/a'), async (href) => href.startsWith('https://cdn.example/'), {
      deps,
    }).catch((error: unknown) => error)
    expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
    expect((err as Error).message).not.toContain(SECRET)
    expect(requested).toEqual(['https://cdn.example/a'])
  })

  test('stops after 5 redirect hops', async () => {
    const requested: string[] = []
    const deps: TranscriptionAudioDeps = {
      resolve: async () => ['1.1.1.1'],
      request: async (url) => {
        requested.push(url.pathname)
        const hop = Number(url.pathname.slice(1))
        return { status: 302, location: `https://cdn.example/${hop + 1}`, body: new Uint8Array() }
      },
    }
    const err = await downloadTranscriptionAudio(new URL('https://cdn.example/0'), async () => true, { deps }).catch(
      (error: unknown) => error,
    )
    expect((err as BreadError).code).toBe('TRANSCRIPTION_URL_BLOCKED')
    expect(requested).toEqual(['/0', '/1', '/2', '/3', '/4', '/5'])
  })
})

describe('lookupPinned under Bun', () => {
  test('returns only the checked address when lookup asks for all', () => {
    const lookup = lookupPinned('1.1.1.1')
    const seen: unknown[] = []
    lookup('169.254.169.254.nip.io', { all: true }, (err, address) => {
      seen.push(err, address)
    })
    expect(seen).toEqual([null, [{ address: '1.1.1.1', family: 4 }]])
  })

  test('connects to the pinned address instead of resolving the hostname', async () => {
    const server = createServer((_req, res) => {
      res.end('from-pin')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const info = server.address() as AddressInfo
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '169.254.169.254.nip.io',
            port: info.port,
            path: '/latest/meta-data',
            method: 'GET',
            agent: false,
            headers: { host: `169.254.169.254.nip.io:${info.port}` },
            lookup: lookupPinned('127.0.0.1'),
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => resolve(Buffer.concat(chunks).toString()))
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(body).toBe('from-pin')
    } finally {
      server.close()
    }
  })
})
