import { describe, expect, test } from 'bun:test'
import { HTTP_ACTIONS, isLoopbackHostname, matchHttpRoute, registerHttpRoute } from '../src/http-grant.js'

const LOOPBACK = [
  'localhost',
  'LOCALHOST',
  'localhost:3000',
  '127.0.0.1',
  '127.0.0.1:80',
  '::1',
  '[::1]',
  '[::1]:3000',
] as const

const NOT_LOOPBACK = [
  'localhost.',
  'localhost.:3000',
  '127.1',
  '0.0.0.0',
  '0.0.0.0:80',
  '::',
  '::1:3000',
  '[::1]:',
  '[localhost]',
  '[127.0.0.1]',
  'example.com',
  'localhost:3000:1',
  '127.0.0.1:',
  '',
] as const

describe('isLoopbackHostname', () => {
  test.each(LOOPBACK)('allows %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  test.each(NOT_LOOPBACK)('rejects %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(false)
  })

  test('rejects a missing host', () => {
    expect(isLoopbackHostname(null)).toBe(false)
    expect(isLoopbackHostname(undefined)).toBe(false)
  })
})

describe('HTTP_ACTIONS', () => {
  test('lists core routes only', () => {
    expect(HTTP_ACTIONS).toEqual({
      agentList: 'agent.list',
      agentRead: 'agent.read',
      runStart: 'run.start',
      pipelineStart: 'pipeline.start',
      runResume: 'run.resume',
      runStream: 'run.stream',
      runCancel: 'run.cancel',
      sessionList: 'session.list',
      sessionRead: 'session.read',
      sessionDelete: 'session.delete',
      sessionCleanup: 'session.cleanup',
      loopList: 'loop.list',
      loopRead: 'loop.read',
      taskList: 'task.list',
      taskRead: 'task.read',
    })
    const names = Object.values(HTTP_ACTIONS)
    expect(names.some((name) => name.startsWith('a2a.') || name.startsWith('ag-ui.') || name.startsWith('mcp.'))).toBe(
      false,
    )
  })
})

describe('matchHttpRoute', () => {
  test('a static path beats a param, including when the param was registered first', () => {
    const app = {}
    registerHttpRoute(app, { method: 'POST', path: '/sessions/:id', action: 'session.read' })
    registerHttpRoute(app, { method: 'GET', path: '/sessions/:id', action: 'session.read' })
    registerHttpRoute(app, { method: 'POST', path: '/sessions/cleanup', action: 'session.cleanup' })

    expect(matchHttpRoute(app, 'POST', '/sessions/cleanup')).toEqual({
      action: 'session.cleanup',
      params: {},
    })
    expect(matchHttpRoute(app, 'GET', '/sessions/cleanup')).toEqual({
      action: 'session.read',
      params: { id: 'cleanup' },
    })
    expect(matchHttpRoute(app, 'post', '/sessions/other')).toEqual({
      action: 'session.read',
      params: { id: 'other' },
    })
  })

  test('a method of * matches every method, and an exact method wins on the same path', () => {
    const app = {}
    registerHttpRoute(app, { method: '*', path: '/mcp', action: 'mcp.request' })
    registerHttpRoute(app, { method: 'POST', path: '/mcp', action: 'mcp.post' })

    expect(matchHttpRoute(app, 'GET', '/mcp')?.action).toBe('mcp.request')
    expect(matchHttpRoute(app, 'DELETE', '/mcp')?.action).toBe('mcp.request')
    expect(matchHttpRoute(app, 'POST', '/mcp')?.action).toBe('mcp.post')
  })

  test('decodes a param and does not throw on a bad escape', () => {
    const app = {}
    registerHttpRoute(app, { method: 'GET', path: '/agents/:id', action: 'agent.read' })
    expect(matchHttpRoute(app, 'GET', '/agents/a%2Fb')).toEqual({ action: 'agent.read', params: { id: 'a/b' } })
    expect(() => matchHttpRoute(app, 'GET', '/agents/%')).not.toThrow()
    expect(matchHttpRoute(app, 'GET', '/agents/%')).toBeUndefined()
  })

  test('registrations do not leak across apps', () => {
    const one = {}
    const two = {}
    registerHttpRoute(one, { method: 'GET', path: '/agents', action: 'agent.list' })
    expect(matchHttpRoute(one, 'GET', '/agents')?.action).toBe('agent.list')
    expect(matchHttpRoute(two, 'GET', '/agents')).toBeUndefined()
  })
})
