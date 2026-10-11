import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { isPublicAddress, loadDocumentSource, pinnedLookup, type DocLoadDeps } from '../src/doc-load.js'
import { BreadError } from '../src/types.js'

const BLOCKED: readonly string[] = [
  '0.0.0.0',
  '0.255.255.255',
  '10.0.0.0',
  '10.255.255.255',
  '100.64.0.0',
  '100.127.255.255',
  '127.0.0.1',
  '127.255.255.255',
  '169.254.0.0',
  '169.254.169.254',
  '169.254.255.255',
  '172.16.0.0',
  '172.31.255.255',
  '192.0.0.0',
  '192.0.0.255',
  '192.0.2.0',
  '192.0.2.255',
  '192.168.0.0',
  '192.168.255.255',
  '198.18.0.0',
  '198.19.255.255',
  '198.51.100.0',
  '198.51.100.255',
  '203.0.113.0',
  '203.0.113.255',
  '224.0.0.0',
  '239.255.255.255',
  '240.0.0.0',
  '255.255.255.254',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::',
  'fc00::1',
  'fd00::1',
  'fdff:ffff::',
  'fe80::',
  'fe80::1',
  'febf:ffff::',
  'ff00::1',
  'ff02::1',
  'ffff::',
  '2001:db8::',
  '2001:db8:ffff::1',
  '::ffff:0.0.0.0',
  '::ffff:10.0.0.1',
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:192.0.2.1',
  '::ffff:a9fe:a9fe',
  '::ffff:7f00:1',
  '[::1]',
  'fe80::1%eth0',
]

const PUBLIC: readonly string[] = [
  '1.1.1.1',
  '8.8.8.8',
  '9.255.255.255',
  '11.0.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '169.255.1.1',
  '192.0.1.1',
  '192.0.3.1',
  '192.169.1.1',
  '198.17.255.255',
  '198.20.0.1',
  '198.51.101.1',
  '203.0.114.1',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:db7::1',
  '2001:db9::1',
  'fbff::1',
  'fe00::1',
  'fec0::1',
  '::ffff:1.1.1.1',
  '::ffff:8.8.8.8',
  '::ffff:101:101',
]

const LITERALS: readonly string[] = [
  'https://127.0.0.1/',
  'https://10.1.2.3/',
  'https://169.254.169.254/latest/meta-data/',
  'https://192.168.1.20/',
  'https://172.16.5.4/',
  'https://0.0.0.0/',
  'https://0/',
  'https://0x7f000001/',
  'https://2130706433/',
  'https://0177.0.0.1/',
  'https://[::1]/',
  'https://[::]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fd00::1]/',
  'https://[ff02::1]/',
  'https://[2001:db8::1]/',
  'https://[::ffff:169.254.169.254]/',
  'https://[::ffff:10.0.0.1]/',
  'https://[::ffff:127.0.0.1]/',
]

function probe(): { deps: DocLoadDeps; resolved: string[]; requested: string[] } {
  const resolved: string[] = []
  const requested: string[] = []
  const deps: DocLoadDeps = {
    resolve: async (hostname) => {
      resolved.push(hostname)
      return ['1.1.1.1']
    },
    request: async (url, address) => {
      requested.push(`${address} ${url.href}`)
      return { status: 200, body: 'should-not-load' }
    },
  }
  return { deps, resolved, requested }
}

async function expectBlocked(source: string, deps: DocLoadDeps): Promise<BreadError> {
  try {
    await loadDocumentSource(source, {}, deps)
  } catch (err) {
    expect(err).toBeInstanceOf(BreadError)
    const error = err as BreadError
    expect(error.code).toBe('DOC_URL_BLOCKED')
    expect(error.message).not.toContain('should-not-load')
    try {
      const hostname = new URL(source).hostname
      if (hostname !== '') expect(error.message).not.toContain(hostname)
      const bare = hostname.replace(/^\[|\]$/g, '')
      if (bare !== '') expect(error.message).not.toContain(bare)
    } catch {
      // source was not a URL
    }
    return error
  }
  throw new Error(`expected ${source} to be blocked`)
}

describe('isPublicAddress', () => {
  test.each(BLOCKED)('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  test.each(PUBLIC)('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })

  test('rejects an unparseable address', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
  })
})

describe('pinned lookup', () => {
  test('returns only the checked address', () => {
    const lookup = pinnedLookup('1.1.1.1')
    const single: unknown[] = []
    lookup('example.com', {}, (err, address, family) => {
      single.push(err, address, family)
    })
    expect(single).toEqual([null, '1.1.1.1', 4])

    const all: unknown[] = []
    lookup('example.com', { all: true }, (err, address) => {
      all.push(err, address)
    })
    expect(all).toEqual([null, [{ address: '1.1.1.1', family: 4 }]])
  })

  test('returns an IPv6 address with family 6', () => {
    const lookup = pinnedLookup('2606:4700:4700::1111')
    let family: number | undefined
    lookup('example.com', {}, (_err, _address, seen) => {
      family = seen
    })
    expect(family).toBe(6)
  })

  test('refuses a non-public address', () => {
    expect(() => pinnedLookup('169.254.169.254')).toThrow(BreadError)
    try {
      pinnedLookup('10.0.0.5')
    } catch (err) {
      expect((err as BreadError).message).not.toContain('10.0.0.5')
    }
  })
})

describe('core_doc_load URLs', () => {
  test('rejects http before resolve', async () => {
    const { deps, resolved, requested } = probe()
    await expectBlocked('http://example.com/secret', deps)
    await expectBlocked('http://169.254.169.254/latest/meta-data', deps)
    expect(resolved).toEqual([])
    expect(requested).toEqual([])
  })

  test('rejects every other scheme before resolve', async () => {
    const { deps, resolved, requested } = probe()
    await expectBlocked('ftp://example.com/file', deps)
    await expectBlocked('file:///etc/passwd', deps)
    await expectBlocked('gopher://example.com/', deps)
    expect(resolved).toEqual([])
    expect(requested).toEqual([])
  })

  test('rejects private and link-local literals before resolve', async () => {
    const { deps, resolved, requested } = probe()
    for (const source of LITERALS) await expectBlocked(source, deps)
    expect(resolved).toEqual([])
    expect(requested).toEqual([])
  })

  test('does not request when any resolved address is non-public', async () => {
    for (const addresses of [['10.0.0.5'], ['8.8.8.8', '10.0.0.5'], ['fd00::1', '1.1.1.1'], ['169.254.169.254']]) {
      const requested: string[] = []
      await expect(
        loadDocumentSource('https://example.com/a', {}, {
          resolve: async () => addresses,
          request: async () => {
            requested.push('called')
            return { status: 200, body: 'nope' }
          },
        }),
      ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
      expect(requested).toEqual([])
    }
  })

  test('does not include a resolved private address in the error', async () => {
    const secret = '10.1.2.3'
    try {
      await loadDocumentSource('https://example.com/', {}, {
        resolve: async () => ['1.1.1.1', secret],
        request: async () => ({ status: 200, body: 'nope' }),
      })
      throw new Error('expected block')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).message).not.toContain(secret)
      expect((err as BreadError).message).not.toContain('1.1.1.1')
    }
  })

  test('rejects a URL with a username or password before resolve', async () => {
    const { deps, resolved, requested } = probe()
    await expectBlocked('https://user:secret@example.com/a', deps)
    await expectBlocked('https://user@example.com/a', deps)
    await expectBlocked('https://example.com@169.254.169.254/', deps)
    expect(resolved).toEqual([])
    expect(requested).toEqual([])
  })

  test('urlAllowlist does not permit a non-public literal', async () => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://169.254.169.254/', { urlAllowlist: ['169.254.169.254'] }, {
        resolve: async () => ['1.1.1.1'],
        request: async () => {
          requested.push('called')
          return { status: 200, body: 'nope' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual([])
  })

  test('loads a public address literal without resolving', async () => {
    let resolved = false
    let seen = ''
    const body = await loadDocumentSource('https://1.1.1.1/doc', {}, {
      resolve: async () => {
        resolved = true
        return ['10.0.0.1']
      },
      request: async (url, address) => {
        seen = `${address} ${url.hostname}`
        return { status: 200, body: 'literal' }
      },
    })
    expect(body).toBe('literal')
    expect(resolved).toBe(false)
    expect(seen).toBe('1.1.1.1 1.1.1.1')
  })

  test('pins the first verbatim public address', async () => {
    let seen = ''
    const body = await loadDocumentSource('https://example.com/a', {}, {
      resolve: async () => ['8.8.8.8', '1.1.1.1'],
      request: async (_url, address) => {
        seen = address
        return { status: 200, body: 'ok' }
      },
    })
    expect(body).toBe('ok')
    expect(seen).toBe('8.8.8.8')
  })
})

describe('core_doc_load redirects', () => {
  test.each([301, 302, 303, 307, 308])('does not connect to an http redirect (%i)', async (status) => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://example.com/start', {}, {
        resolve: async () => ['1.1.1.1'],
        request: async (url) => {
          requested.push(url.href)
          return { status, location: 'http://example.com/secret', body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual(['https://example.com/start'])
  })

  test('does not connect to a redirect at a private literal', async () => {
    const requested: string[] = []
    const resolved: string[] = []
    await expect(
      loadDocumentSource('https://example.com/start', {}, {
        resolve: async (hostname) => {
          resolved.push(hostname)
          return ['1.1.1.1']
        },
        request: async (url) => {
          requested.push(url.href)
          return { status: 302, location: 'https://169.254.169.254/latest', body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual(['https://example.com/start'])
    expect(resolved).toEqual(['example.com'])
  })

  test('does not connect to a redirect that resolves to a private address', async () => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://example.com/start', {}, {
        resolve: async (hostname) => (hostname === 'metadata.internal' ? ['169.254.169.254'] : ['8.8.8.8']),
        request: async (url) => {
          requested.push(url.hostname)
          return { status: 307, location: 'https://metadata.internal/latest', body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual(['example.com'])
  })

  test('does not follow a redirect that is not one of the five redirect statuses', async () => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://example.com/start', {}, {
        resolve: async () => ['1.1.1.1'],
        request: async (url) => {
          requested.push(url.href)
          return { status: 304, location: 'http://169.254.169.254/', body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_FETCH_FAILED' })
    expect(requested).toEqual(['https://example.com/start'])
  })

  test('follows a relative redirect to another public https URL', async () => {
    const requested: string[] = []
    const body = await loadDocumentSource('https://example.com/a', {}, {
      resolve: async () => ['1.1.1.1'],
      request: async (url) => {
        requested.push(url.href)
        if (url.pathname === '/a') return { status: 302, location: '/b', body: '' }
        return { status: 200, body: 'final' }
      },
    })
    expect(body).toBe('final')
    expect(requested).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  test('re-checks urlAllowlist on a redirect and does not connect off-list', async () => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://example.com/a', { urlAllowlist: ['example.com'] }, {
        resolve: async () => ['1.1.1.1'],
        request: async (url) => {
          requested.push(url.hostname)
          return { status: 302, location: 'https://cdn.example/b', body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual(['example.com'])
  })

  test('stops after 5 redirect hops', async () => {
    const requested: string[] = []
    await expect(
      loadDocumentSource('https://example.com/0', {}, {
        resolve: async () => ['1.1.1.1'],
        request: async (url) => {
          requested.push(url.pathname)
          const hop = Number(url.pathname.slice(1))
          return { status: 302, location: `https://example.com/${hop + 1}`, body: '' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(requested).toEqual(['/0', '/1', '/2', '/3', '/4', '/5'])
  })

  test('returns the body after five redirect hops land on https', async () => {
    const body = await loadDocumentSource('https://example.com/0', {}, {
      resolve: async () => ['1.1.1.1'],
      request: async (url) => {
        const hop = Number(url.pathname.slice(1))
        if (hop >= 5) return { status: 200, body: 'landed' }
        return { status: 302, location: `https://example.com/${hop + 1}`, body: '' }
      },
    })
    expect(body).toBe('landed')
  })
})

describe('core_doc_load urlAllowlist', () => {
  test('rejects a host that is not listed', async () => {
    let resolved = false
    let requested = false
    await expect(
      loadDocumentSource('https://evil.example/a', { urlAllowlist: ['example.com'] }, {
        resolve: async () => {
          resolved = true
          return ['1.1.1.1']
        },
        request: async () => {
          requested = true
          return { status: 200, body: 'nope' }
        },
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(resolved).toBe(false)
    expect(requested).toBe(false)
  })

  test('an empty allowlist denies every URL', async () => {
    let resolved = false
    await expect(
      loadDocumentSource('https://example.com/', { urlAllowlist: [] }, {
        resolve: async () => {
          resolved = true
          return ['1.1.1.1']
        },
        request: async () => ({ status: 200, body: 'nope' }),
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    expect(resolved).toBe(false)
  })

  test('matches the hostname case-insensitively and ignores a port or wildcard entry', async () => {
    const seen: string[] = []
    const body = await loadDocumentSource('https://Example.COM/a', { urlAllowlist: ['example.com'] }, {
      resolve: async (hostname) => {
        seen.push(hostname)
        return ['1.1.1.1']
      },
      request: async (_url, address) => {
        seen.push(address)
        return { status: 200, body: 'ok' }
      },
    })
    expect(body).toBe('ok')
    expect(seen).toEqual(['example.com', '1.1.1.1'])

    await expect(
      loadDocumentSource('https://example.com/', { urlAllowlist: ['example.com:443'] }, {
        resolve: async () => ['1.1.1.1'],
        request: async () => ({ status: 200, body: 'nope' }),
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
    await expect(
      loadDocumentSource('https://a.example.com/', { urlAllowlist: ['*.example.com'] }, {
        resolve: async () => ['1.1.1.1'],
        request: async () => ({ status: 200, body: 'nope' }),
      }),
    ).rejects.toMatchObject({ code: 'DOC_URL_BLOCKED' })
  })
})

describe('core_doc_load files', () => {
  test('rejects a file when fileRoot is not set', async () => {
    const source = join(import.meta.dir, 'fixtures', 'doc.txt')
    await expect(loadDocumentSource(source)).rejects.toMatchObject({ code: 'DOC_FILE_DISABLED' })
    await expect(loadDocumentSource(source, {})).rejects.toMatchObject({ code: 'DOC_FILE_DISABLED' })
    await expect(loadDocumentSource(source, { fileRoot: '' })).rejects.toMatchObject({ code: 'DOC_FILE_DISABLED' })
  })

  test('reads a file inside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-doc-load-'))
    try {
      const root = join(dir, 'root')
      await mkdir(root)
      await writeFile(join(root, 'ok.txt'), 'hello inside')
      expect(await loadDocumentSource(join(root, 'ok.txt'), { fileRoot: root })).toBe('hello inside')
      expect(await loadDocumentSource('ok.txt', { fileRoot: root })).toBe('hello inside')
      const rel = relative(process.cwd(), root)
      expect(await loadDocumentSource('ok.txt', { fileRoot: rel })).toBe('hello inside')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a symlink inside the root that points outside', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-doc-load-'))
    try {
      const root = join(dir, 'root')
      await mkdir(root)
      const outside = join(dir, 'secret.txt')
      await writeFile(outside, 'secret-outside')
      await symlink(outside, join(root, 'link.txt'))
      try {
        await loadDocumentSource('link.txt', { fileRoot: root })
        throw new Error('expected escape')
      } catch (err) {
        expect(err).toBeInstanceOf(BreadError)
        const error = err as BreadError
        expect(error.code).toBe('DOC_FILE_ESCAPE')
        expect(error.message).not.toContain('secret-outside')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('allows a symlink that stays inside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-doc-load-'))
    try {
      const root = join(dir, 'root')
      await mkdir(root)
      await writeFile(join(root, 'ok.txt'), 'hello inside')
      await symlink(join(root, 'ok.txt'), join(root, 'alias.txt'))
      expect(await loadDocumentSource('alias.txt', { fileRoot: root })).toBe('hello inside')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a sibling directory whose name extends the root name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-doc-load-'))
    try {
      const root = join(dir, 'root')
      const sibling = join(dir, 'root-extra')
      await mkdir(root)
      await mkdir(sibling)
      await writeFile(join(sibling, 'secret.txt'), 'secret-outside')
      try {
        await loadDocumentSource(join(sibling, 'secret.txt'), { fileRoot: root })
        throw new Error('expected escape')
      } catch (err) {
        expect(err).toBeInstanceOf(BreadError)
        const error = err as BreadError
        expect(error.code).toBe('DOC_FILE_ESCAPE')
        expect(error.message).not.toContain('secret-outside')
      }
      await expect(loadDocumentSource(join('..', 'root-extra', 'secret.txt'), { fileRoot: root })).rejects.toMatchObject({
        code: 'DOC_FILE_ESCAPE',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
