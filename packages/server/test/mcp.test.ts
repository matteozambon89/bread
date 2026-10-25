import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { runMcpAdd, runMcpList } from '@breadai/server'
import { renderMcpServerEntry } from '../src/commands/mcp.js'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'bread-mcp-'))
  return dir
}

function capture(): { log: (line: string) => void; text: () => string } {
  const lines: string[] = []
  return { log: (line) => lines.push(line), text: () => lines.join('\n') }
}

function objectText(text: string): string {
  const start = text.indexOf('\n{')
  return text.slice(start + 1, text.lastIndexOf('}') + 1)
}

const OAUTH_NOTE = 'Per-user OAuth is not available in this command. It waits on issue #41.'

describe('runMcpList', () => {
  test('prints each connector name, namespace, url, auth, and version', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpList({ cwd, log: out.log })
    const stripe = out.text().split('\n').find((line) => line.includes('com.stripe'))
    const paypal = out.text().split('\n').find((line) => line.includes('com.paypal.mcp'))
    const neon = out.text().split('\n').find((line) => line.includes('com.neon'))
    expect(stripe).toContain('stripe')
    expect(stripe).toContain('https://mcp.stripe.com')
    expect(stripe).toContain('oauth')
    expect(stripe).not.toContain('none')
    expect(stripe).toContain('0.2.4')
    expect(paypal).toContain('paypal')
    expect(paypal).toContain('https://mcp.paypal.com/mcp')
    expect(paypal).toContain('api_key')
    expect(paypal).toContain('1.0.0')
    expect(neon).toContain('api_key')
    for (const name of [
      'airtable',
      'atlassian',
      'figma',
      'notion',
      'stripe',
      'supabase',
      'webflow',
      'workos',
      'zapier',
    ]) {
      const line = out.text().split('\n').find((item) => item.trimStart().startsWith(`${name} `))
      expect(line).toContain('oauth')
      expect(line).not.toContain('none')
    }
  })
})

describe('runMcpAdd', () => {
  test('an unknown connector throws UNKNOWN_MCP_CONNECTOR and lists the allowlist', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, name: 'strip', log: () => {} })).rejects.toMatchObject({
      code: 'UNKNOWN_MCP_CONNECTOR',
      message: expect.stringContaining('stripe'),
    })
  })

  test('a positional name and --url throw MCP_ADD_EXCLUSIVE', async () => {
    const cwd = tempDir()
    await expect(
      runMcpAdd({ cwd, name: 'stripe', url: 'http://example.com/mcp', serverName: 'demo', log: () => {} }),
    ).rejects.toMatchObject({ code: 'MCP_ADD_EXCLUSIVE' })
  })

  test('--url without --name throws MCP_NAME_REQUIRED', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, url: 'http://example.com/mcp', log: () => {} })).rejects.toMatchObject({
      code: 'MCP_NAME_REQUIRED',
    })
  })

  test('a missing name and a missing --url throws MCP_ADD_TARGET_REQUIRED', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, log: () => {} })).rejects.toMatchObject({ code: 'MCP_ADD_TARGET_REQUIRED' })
  })

  test('an invalid allowlist name throws INVALID_NAME', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, name: 'Stripe', log: () => {} })).rejects.toMatchObject({ code: 'INVALID_NAME' })
  })

  test('an invalid --name throws INVALID_NAME', async () => {
    const cwd = tempDir()
    await expect(
      runMcpAdd({ cwd, url: 'http://example.com/mcp', serverName: 'Bad-Name', log: () => {} }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' })
  })

  test('an allowlist name with --name Bad-Name throws INVALID_NAME', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, name: 'stripe', serverName: 'Bad-Name', log: () => {} })).rejects.toMatchObject({
      code: 'INVALID_NAME',
    })
  })

  test('--name without --url throws MCP_NAME_REQUIRES_URL', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, name: 'stripe', serverName: 'demo', log: () => {} })).rejects.toMatchObject({
      code: 'MCP_NAME_REQUIRES_URL',
    })
    await expect(runMcpAdd({ cwd, serverName: 'demo', log: () => {} })).rejects.toMatchObject({
      code: 'MCP_NAME_REQUIRES_URL',
    })
  })

  test('--url that is not a URL throws MCP_INVALID_URL', async () => {
    const cwd = tempDir()
    await expect(runMcpAdd({ cwd, url: 'not a url', serverName: 'demo', log: () => {} })).rejects.toMatchObject({
      code: 'MCP_INVALID_URL',
    })
  })

  test('--url with a scheme other than http or https throws MCP_INVALID_URL', async () => {
    const cwd = tempDir()
    await expect(
      runMcpAdd({ cwd, url: 'file:///etc/passwd', serverName: 'demo', log: () => {} }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_URL' })
  })

  test('--url prints the parsed href, so a newline in the input does not reach the snippet', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpAdd({ cwd, url: 'http://127.0.0.1/m\ncp', serverName: 'demo', log: out.log })
    expect(out.text()).toContain("url: 'http://127.0.0.1/mcp',")
    expect(out.text()).not.toContain('/m\ncp')
  })

  test('--url prints that http url and does not set askWrites', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpAdd({ cwd, url: 'http://127.0.0.1/mcp', serverName: 'demo', log: out.log })
    expect(out.text()).toContain('http://127.0.0.1/mcp')
    expect(out.text()).not.toContain('askWrites')
    expect(out.text()).not.toContain('signer')
    expect(out.text()).not.toContain('envProvider')
  })

  test('an api_key snippet calls mcpCredentials.get and contains no secret literal', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpAdd({ cwd, name: 'paypal', log: out.log })
    const text = out.text()
    expect(text).toContain(
      '[bread] Paste the import and const into bread.config.ts and the object into mcpClient({ servers }). Nothing was written.',
    )
    expect(text).toContain("import { envProvider } from '@breadai/core'")
    expect(text).toContain('const mcpCredentials = envProvider()')
    expect(text).toContain("mcpCredentials.get('paypal_api_key')")
    expect(text).not.toMatch(/\bcredentials\b/)
    expect(text).toContain("headers.set('Authorization', `Bearer ${secret}`)")
    expect(text).not.toContain("headers.set('Authorization', secret)")
    expect(text).not.toMatch(/sk_live|sk_test|Bearer [A-Za-z0-9._-]{8,}/)
  })

  test('paypal and neon snippets send Authorization Bearer and throw when get returns nothing', async () => {
    for (const [name, credential] of [
      ['paypal', 'paypal_api_key'],
      ['neon', 'neon_api_key'],
    ] as const) {
      const cwd = tempDir()
      const out = capture()
      await runMcpAdd({ cwd, name, log: out.log })
      const text = out.text()
      const body = objectText(text)
      expect(body).toContain(`mcpCredentials.get('${credential}')`)
      expect(body).not.toMatch(/\bcredentials\b/)
      expect(body).toContain('if (!secret) throw new Error(')
      const importAt = text.indexOf("import { envProvider } from '@breadai/core'")
      expect(importAt).toBeGreaterThan(-1)
      const file = join(import.meta.dir, `mcp-snippet-${name}.ts`)
      writeFileSync(file, `${text.slice(importAt).replace('\n{', '\nexport default {')}\n`)
      const previous = process.env[credential]
      try {
        delete process.env[credential]
        const loaded = (await import(file)) as {
          default: { signer: { sign: (headers: Headers) => Promise<void> } }
        }
        const missing = new Headers()
        await expect(loaded.default.signer.sign(missing)).rejects.toThrow(credential)
        expect(missing.get('authorization')).toBeNull()
        process.env[credential] = 'stored-key'
        const present = new Headers()
        await loaded.default.signer.sign(present)
        expect(present.get('authorization')).toBe('Bearer stored-key')
      } finally {
        if (previous === undefined) delete process.env[credential]
        else process.env[credential] = previous
        rmSync(file, { force: true })
      }
    }
  })

  test('an allowlisted connector prints askWrites', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpAdd({ cwd, name: 'stripe', log: out.log })
    expect(out.text()).toContain('askWrites: true')
  })

  test('an oauth add logs the issue line before the object and still sets askWrites', async () => {
    const cwd = tempDir()
    const out = capture()
    await runMcpAdd({ cwd, name: 'stripe', log: out.log })
    const text = out.text()
    const warningAt = text.indexOf(OAUTH_NOTE)
    const objectAt = text.indexOf('\n{')
    expect(warningAt).toBeGreaterThan(-1)
    expect(objectAt).toBeGreaterThan(warningAt)
    const body = objectText(text)
    expect(body).not.toContain(OAUTH_NOTE)
    expect(body).not.toContain('issue #41')
    expect(body).toContain('askWrites: true')
    expect(body).not.toContain('signer')
    expect(text).not.toContain('clientId')
    expect(text).not.toContain('tokenUrl')
    expect(text).not.toContain('envProvider')
  })

  test('does not create bread.config.ts', async () => {
    const cwd = tempDir()
    await runMcpList({ cwd, log: () => {} })
    await runMcpAdd({ cwd, name: 'stripe', log: () => {} })
    await runMcpAdd({ cwd, url: 'http://127.0.0.1/mcp', serverName: 'demo', log: () => {} })
    expect(readdirSync(cwd)).not.toContain('bread.config.ts')
    expect(readdirSync(cwd)).toEqual([])
  })

  test('prints with console.log when log is omitted', async () => {
    const cwd = tempDir()
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await runMcpAdd({ cwd, name: 'stripe' })
    } finally {
      console.log = original
    }
    expect(lines.join('\n')).toContain('https://mcp.stripe.com')
  })
})

describe('renderMcpServerEntry', () => {
  test('an oauth entry is only the object and has no signer', () => {
    const text = renderMcpServerEntry(
      { name: 'vendor', url: 'https://mcp.example.com/mcp', auth: 'oauth' },
      true,
    )
    expect(text.startsWith('{')).toBe(true)
    expect(text.endsWith('}')).toBe(true)
    expect(text).toContain('https://mcp.example.com/mcp')
    expect(text).toContain('askWrites: true')
    expect(text).not.toContain(OAUTH_NOTE)
    expect(text).not.toContain('signer')
    expect(text).not.toContain('clientId')
    expect(text).not.toContain('tokenUrl')
    expect(text).not.toContain('envProvider')
  })

  test('a none entry prints no signer', () => {
    const text = renderMcpServerEntry({ name: 'demo', url: 'http://127.0.0.1/mcp', auth: 'none' }, false)
    expect(text).not.toContain('signer')
    expect(text).not.toContain('askWrites')
    expect(text).not.toContain(OAUTH_NOTE)
  })
})
