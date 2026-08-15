export { authMiddleware, authPlugin, createServer, startServer } from './server.js'
export { loadConfig, loadAgents, loadEvals, loadTasks } from './loader.js'
export type { ServerOptions } from './server.js'

// Command runners — consumed by the @breadai/cli binary.
export { runDev } from './commands/dev.js'
export { runBuild } from './commands/build.js'
export { runStart } from './commands/start.js'
export { runChat } from './commands/chat.js'
export { runEvalCommand } from './commands/eval.js'
export { runInvoke } from './commands/invoke.js'
export { listSessions, cleanupSessions } from './commands/sessions.js'
export { runProviderList, runProviderAdd } from './commands/provider.js'
