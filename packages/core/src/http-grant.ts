// Exact names only. Do not strip a trailing dot or expand 127.1 / :: — those
// are not loopback, and normalizing them would widen the exemption.
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1'])

/** True for `localhost`, `127.0.0.1`, or `::1`, optional port, or bracketed `[::1]`. */
export function isLoopbackHostname(host: string | null | undefined): boolean {
  if (host == null || host === '') return false
  const value = host.toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return false
    const name = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return false
    return name === '::1'
  }
  const colon = value.lastIndexOf(':')
  if (colon !== -1) {
    const name = value.slice(0, colon)
    const port = value.slice(colon + 1)
    if (/^\d+$/.test(port) && !name.includes(':')) return LOOPBACK_NAMES.has(name)
  }
  return LOOPBACK_NAMES.has(value)
}

// Core route names only. Plugins register their own; this object does not list them.
export const HTTP_ACTIONS = {
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
} as const

interface CompiledRoute {
  method: string
  action: string
  segments: Array<{ param: string } | { text: string }>
  staticCount: number
}

const grants = new WeakMap<object, CompiledRoute[]>()

function segmentsOf(path: string): string[] {
  if (path === '' || path === '/') return []
  const body = path.startsWith('/') ? path.slice(1) : path
  return body.split('/')
}

function decodePart(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/** Name one HTTP route. A plugin that only calls `app.get` / `app.post` leaves it unnamed. */
export function registerHttpRoute(
  app: object,
  route: { method: string; path: string; action: string },
): void {
  const method = route.method === '*' ? '*' : route.method.toUpperCase()
  const raw = segmentsOf(route.path)
  let staticCount = 0
  const segments = raw.map((part) => {
    if (part.startsWith(':') && part.length > 1) return { param: part.slice(1) }
    staticCount += 1
    return { text: part }
  })
  const compiled: CompiledRoute = { method, action: route.action, segments, staticCount }
  const list = grants.get(app)
  if (list) list.push(compiled)
  else grants.set(app, [compiled])
}

/**
 * Match a request to a registered grant. Static segments outrank params, so
 * `/sessions/cleanup` is not `/sessions/:id`. An exact method outranks `*`.
 */
export function matchHttpRoute(
  app: object,
  method: string,
  pathname: string,
): { action: string; params: Record<string, string> } | undefined {
  const list = grants.get(app)
  if (!list) return undefined
  const requestMethod = method.toUpperCase()
  const parts = segmentsOf(pathname)
  let best: { action: string; params: Record<string, string>; rank: number } | undefined
  for (const route of list) {
    if (route.method !== '*' && route.method !== requestMethod) continue
    if (route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < parts.length; i++) {
      const segment = route.segments[i]!
      const decoded = decodePart(parts[i]!)
      if (decoded === undefined) {
        matched = false
        break
      }
      if ('text' in segment) {
        if (segment.text !== decoded) {
          matched = false
          break
        }
      } else {
        params[segment.param] = decoded
      }
    }
    if (!matched) continue
    const rank = route.staticCount * 2 + (route.method === requestMethod ? 1 : 0)
    if (!best || rank > best.rank) best = { action: route.action, params, rank }
  }
  return best ? { action: best.action, params: best.params } : undefined
}
