import { describe, expect, test } from 'bun:test'
import type { BreadAuthStrategy, BreadConfig, BreadInstance, BreadPlugin } from '@breadai/core'
import { BreadError, HTTP_ACTIONS, matchHttpRoute } from '@breadai/core'
import { Hono } from 'hono'
import { assertHttpAuth, authPlugin, httpAuthLoopbackWarning } from '@breadai/server'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'

const GATED: Array<[string, string]> = [
  ['GET', '/agents'],
  ['GET', '/agents/greeter'],
  ['POST', '/agents/greeter/run'],
  ['POST', '/pipelines/missing/run'],
  ['POST', '/resume/missing'],
  ['POST', '/runs/missing/cancel'],
  ['GET', '/sessions'],
  ['GET', '/sessions/s1'],
  ['DELETE', '/sessions/s1'],
  ['POST', '/sessions/cleanup'],
  ['GET', '/loops'],
  ['GET', '/loops/loop1'],
  ['GET', '/tasks'],
  ['GET', '/tasks/t1'],
]

function watchStore(bread: BreadInstance): { calls: string[] } {
  const calls: string[] = []
  const mark = (name: string) => {
    calls.push(name)
  }
  bread.store.listSessions = async () => {
    mark('listSessions')
    return [
      { id: 'secret', messages: [] },
      { id: 'ok', messages: [] },
    ] as never
  }
  bread.store.getSession = async () => {
    mark('getSession')
    return undefined
  }
  bread.store.deleteSession = async () => {
    mark('deleteSession')
  }
  bread.store.cleanupSessions = async () => {
    mark('cleanupSessions')
    return 2
  }
  bread.store.listLoops = async () => {
    mark('listLoops')
    return []
  }
  bread.store.getLoop = async () => {
    mark('getLoop')
    return undefined
  }
  bread.store.listTaskRuns = async () => {
    mark('listTaskRuns')
    return []
  }
  bread.store.getTaskRun = async () => {
    mark('getTaskRun')
    return undefined
  }
  return { calls }
}

const member: BreadAuthStrategy = {
  name: 'member',
  authenticate: () => ({ subject: 'ada', claims: { admin: true, role: 'admin' } }),
}

describe('http grants', () => {
  test('a public Host is 403 for every core route and does not touch the store', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    const { calls } = watchStore(bread)
    try {
      for (const [method, path] of GATED) {
        const res = await app.request(`http://example.com${path}`, {
          method,
          headers: { 'x-forwarded-host': 'localhost' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden' })
      }
      expect(calls).toEqual([])
      expect(matchHttpRoute(app, 'GET', '/runs/abc/stream')?.action).toBe(HTTP_ACTIONS.runStream)
      expect(matchHttpRoute(app, 'POST', '/sessions/cleanup')?.action).toBe(HTTP_ACTIONS.sessionCleanup)
      expect(matchHttpRoute(app, 'GET', '/sessions/cleanup')).toEqual({
        action: HTTP_ACTIONS.sessionRead,
        params: { id: 'cleanup' },
      })
    } finally {
      await stop()
    }
  })

  test('loopback hosts are allowed, and a present Host wins over the URL', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    let listed = 0
    bread.store.listSessions = async () => {
      listed += 1
      return []
    }
    try {
      for (const url of [
        '/sessions',
        'http://localhost:3000/sessions',
        'http://127.0.0.1/sessions',
        'http://[::1]/sessions',
        'http://[::1]:3000/sessions',
      ]) {
        const res = await app.request(url)
        expect(res.status).toBe(200)
      }
      const spoofedLoopback = await app.request('http://example.com/sessions', {
        headers: { host: 'localhost' },
      })
      expect(spoofedLoopback.status).toBe(200)
      const shortened = await app.request('/sessions', { headers: { host: '127.1' } })
      expect(shortened.status).toBe(403)
      const forwarded = await app.request('http://example.com/sessions', {
        headers: { 'x-forwarded-host': 'localhost' },
      })
      expect(forwarded.status).toBe(403)
      expect(listed).toBe(6)
    } finally {
      await stop()
    }
  })

  test('auth calls authorize with the identity, action, and route args', async () => {
    const seen: Array<{ subject: string; action: string; args: Record<string, string> }> = []
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [authPlugin([member])],
      config: {
        server: {
          authorize: async (identity, action, args) => {
            seen.push({ subject: identity.subject, action, args: { ...args } })
            if (action === HTTP_ACTIONS.sessionRead && args.id === 'secret') return false
            if (action === HTTP_ACTIONS.sessionList && args.tag === 'deny') return false
            if (action === HTTP_ACTIONS.sessionCleanup && args.tag === 'deny') return false
            return true
          },
        },
      },
    })
    const { calls } = watchStore(bread)
    try {
      const denied = await app.request('http://example.com/sessions/secret')
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Forbidden' })

      const allowed = await app.request('http://example.com/sessions/ok')
      expect(allowed.status).toBe(404)

      const listed = await app.request('http://localhost/sessions?tag=keep')
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([
        { id: 'secret', messages: [] },
        { id: 'ok', messages: [] },
      ])

      const deniedList = await app.request('/sessions?tag=deny')
      expect(deniedList.status).toBe(403)
      await deniedList.json()

      const pathWins = await app.request('/sessions/path-id?id=query-id&id=later&tag=a&tag=b')
      expect(pathWins.status).toBe(404)
      await pathWins.json()

      const cleanup = await app.request('/sessions/cleanup?tag=keep', {
        method: 'POST',
        body: JSON.stringify({ olderThanDays: 1 }),
      })
      expect(cleanup.status).toBe(200)
      expect(await cleanup.json()).toEqual({ deleted: 2 })

      const deniedCleanup = await app.request('/sessions/cleanup?tag=deny', {
        method: 'POST',
        body: '{}',
      })
      expect(deniedCleanup.status).toBe(403)
      await deniedCleanup.json()

      expect(calls.filter((name) => name === 'getSession')).toEqual(['getSession', 'getSession'])
      expect(calls.filter((name) => name === 'listSessions')).toEqual(['listSessions'])
      expect(calls.filter((name) => name === 'cleanupSessions')).toEqual(['cleanupSessions'])
      expect(seen.map((entry) => entry.action)).toEqual([
        HTTP_ACTIONS.sessionRead,
        HTTP_ACTIONS.sessionRead,
        HTTP_ACTIONS.sessionList,
        HTTP_ACTIONS.sessionList,
        HTTP_ACTIONS.sessionRead,
        HTTP_ACTIONS.sessionCleanup,
        HTTP_ACTIONS.sessionCleanup,
      ])
      expect(seen[0]).toMatchObject({ subject: 'ada', args: { id: 'secret' } })
      expect(seen[4]?.args).toEqual({ id: 'path-id', tag: 'a' })
      expect(seen[5]?.args).toEqual({ tag: 'keep' })
      expect(seen.every((entry) => !('olderThanDays' in entry.args))).toBe(true)
    } finally {
      await stop()
    }
  })

  test('claims.admin does not allow a route authorize denied', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [authPlugin([member])],
      config: { server: { authorize: () => false } },
    })
    try {
      const res = await app.request('http://localhost/agents')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    } finally {
      await stop()
    }
  })

  test('a missing authorize is 403 and createServer still returns the app', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [authPlugin([member])],
    })
    try {
      const res = await app.request('/agents')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    } finally {
      await stop()
    }
  })

  test('without an auth plugin, authorize is not called', async () => {
    let called = 0
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      config: {
        server: {
          authorize: () => {
            called += 1
            return false
          },
        },
      },
    })
    try {
      const allowed = await app.request('/agents')
      expect(allowed.status).toBe(200)
      const denied = await app.request('http://example.com/agents')
      expect(denied.status).toBe(403)
      expect(called).toBe(0)
    } finally {
      await stop()
    }
  })

  test('an unregistered route is 403 when auth is on, even if authorize allows', async () => {
    const actions: string[] = []
    const extra: BreadPlugin = {
      name: 'extra',
      routes(app) {
        ;(app as Hono).get('/extra', (c) => c.json({ ok: true }))
      },
    }
    const authed = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [
        extra,
        authPlugin([member]),
      ],
      config: {
        server: {
          authorize(_identity, action) {
            actions.push(action)
            return true
          },
        },
      },
    })
    try {
      const res = await authed.app.request('/extra')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
      expect(actions).toEqual([])
    } finally {
      await authed.stop()
    }

    const open = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [extra],
    })
    try {
      const allowed = await open.app.request('/extra')
      expect(allowed.status).toBe(200)
      const denied = await open.app.request('http://example.com/extra')
      expect(denied.status).toBe(403)
    } finally {
      await open.stop()
    }
  })
})

function bare(plugins?: BreadPlugin[]): BreadConfig {
  return { entrypoints: [], ...(plugins ? { plugins } : {}) }
}

describe('assertHttpAuth and httpAuthLoopbackWarning', () => {
  test('a public bind with no auth plugin throws AUTH_NOT_CONFIGURED', () => {
    expect(() => assertHttpAuth(bare(), '0.0.0.0')).toThrow(BreadError)
    try {
      assertHttpAuth(bare(), '0.0.0.0')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      const error = err as BreadError
      expect(error.code).toBe('AUTH_NOT_CONFIGURED')
      expect(error.message).toContain('authPlugin')
      expect(error.message).toContain('spoofed Host')
    }
  })

  test('loopback with no auth does not throw', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(() => assertHttpAuth(bare(), host)).not.toThrow()
    }
  })

  test('auth and authorize on a public bind does not throw', () => {
    const config = bare([{ name: 'auth' }])
    config.server = { authorize: () => true }
    expect(() => assertHttpAuth(config, '0.0.0.0')).not.toThrow()
    expect(() => assertHttpAuth(config, 'localhost')).not.toThrow()
  })

  test('auth without authorize throws on loopback and on a public bind', () => {
    const config = bare([{ name: 'auth' }])
    for (const host of ['localhost', '0.0.0.0']) {
      try {
        assertHttpAuth(config, host)
        throw new Error('expected throw')
      } catch (err) {
        expect((err as BreadError).code).toBe('AUTH_NOT_CONFIGURED')
      }
    }
  })

  test('authorize without auth throws only on a public bind', () => {
    const config = bare()
    config.server = { authorize: () => true }
    expect(() => assertHttpAuth(config, 'localhost')).not.toThrow()
    expect(() => assertHttpAuth(config, '0.0.0.0')).toThrow(BreadError)
  })

  test('middleware under another plugin name does not count as auth', () => {
    const other: BreadPlugin = { name: 'not-auth', middleware() {} }
    expect(() => assertHttpAuth(bare([other]), '0.0.0.0')).toThrow(BreadError)
  })

  test('the loopback warning is non-empty only with no auth on a loopback bind', () => {
    const open = bare()
    const openWithAuthorize: BreadConfig = { ...bare(), server: { authorize: () => true } }
    const auth = bare([{ name: 'auth' }])
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      const warning = httpAuthLoopbackWarning(open, host)
      expect(warning).toContain('reverse proxy')
      expect(warning).toContain('localhost')
      expect(warning).toContain('[::1]')
      expect(warning).toContain('docs/auth.md#guarding-the-server')
      expect(httpAuthLoopbackWarning(openWithAuthorize, host)).toContain('reverse proxy')
      expect(httpAuthLoopbackWarning(auth, host)).toBe('')
    }
    expect(httpAuthLoopbackWarning(open, '0.0.0.0')).toBe('')
    expect(httpAuthLoopbackWarning(open, '::')).toBe('')
  })
})
