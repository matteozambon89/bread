export { authMiddleware, authPlugin, createServer } from './server.js'
export { loadConfig, loadAgents, loadEvals, loadTasks } from './loader.js'
export type { ServerOptions } from './server.js'

// Command runners — consumed by the @breadai/cli binary.
// Listen is injected by the CLI (Bun: @breadai/runtime-bun) so this package
// never depends on a runtime adapter.
export { runDev } from './commands/dev.js'
export { runBuild } from './commands/build.js'
export { runStart } from './commands/start.js'
export { runChat } from './commands/chat.js'
export { runEvalCommand } from './commands/eval.js'
export { runInvoke } from './commands/invoke.js'
export { listSessions, cleanupSessions } from './commands/sessions.js'
export { runProviderList, runProviderAdd } from './commands/provider.js'
export type { ListenFn } from './commands/listen.js'
