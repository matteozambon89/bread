import { resolve } from 'node:path'
import { Command } from 'commander'
import {
  cleanupSessions,
  listSessions,
  runBuild,
  runChat,
  runDev,
  runEvalCommand,
  runInvoke,
  runProviderAdd,
  runProviderList,
  runStart,
} from '@bread/server'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

// --cwd names the project root: enter it so relative paths inside
// bread.config.ts (sqlite files, script paths, …) resolve against the project,
// exactly as if the command had been run from that directory.
function enterProjectRoot(dir: string): string {
  const root = resolve(dir)
  try {
    process.chdir(root)
  } catch {
    throw new Error(`--cwd directory does not exist: ${root}`)
  }
  return root
}

// Commander options carry no defaults for port/host/idleTimeout so an omitted
// flag falls through to config.server.{port,host,idleTimeout} (then
// 3000/localhost/Bun's own default) in startServer — a flag default here
// would silently shadow the config.
function serveOverrides(opts: { port?: string; host?: string; idleTimeout?: string }): {
  port?: number
  host?: string
  idleTimeout?: number
} {
  return {
    ...(opts.port !== undefined ? { port: parseInt(opts.port, 10) } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.idleTimeout !== undefined ? { idleTimeout: parseInt(opts.idleTimeout, 10) } : {}),
  }
}

const program = new Command()
  .name('bread')
  .description('bread — an explicit-by-design framework for AI agents')
  .version('0.1.0')

program
  .command('dev')
  .description('Start dev server with hot reload')
  .option('-p, --port <port>', 'Port to listen on (default: config.server.port, then 3000)')
  .option('-H, --host <host>', 'Host to bind (default: config.server.host, then localhost)')
  .option(
    '--idle-timeout <seconds>',
    'Connection idle timeout (default: config.server.idleTimeout, then Bun.serve\'s own default of 10s)',
  )
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await runDev({ cwd: enterProjectRoot(opts.cwd), ...serveOverrides(opts) })
  })

program
  .command('build')
  .description('Validate every agent has an inputSchema, outputSchema, and complete model config')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await runBuild({ cwd: enterProjectRoot(opts.cwd) })
  })

program
  .command('start')
  .description('Start production server (no watch, no source maps)')
  .option('-p, --port <port>', 'Port to listen on (default: config.server.port, then 3000)')
  .option('-H, --host <host>', 'Host to bind (default: config.server.host, then localhost)')
  .option(
    '--idle-timeout <seconds>',
    'Connection idle timeout (default: config.server.idleTimeout, then Bun.serve\'s own default of 10s)',
  )
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await runStart({ cwd: enterProjectRoot(opts.cwd), ...serveOverrides(opts) })
  })

program
  .command('eval [path]')
  .description('Run evals in agents/**/evals/*.eval.ts (or scoped path)')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (path, opts) => {
    await runEvalCommand({ cwd: enterProjectRoot(opts.cwd), path })
  })

program
  .command('chat [agent]')
  .description('Interactive chat with an agent (supports human-in-the-loop)')
  .option('--skill <skill>', 'Skill to scope the run')
  .option('-s, --session <id>', 'Resume an existing session id')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (agent, opts) => {
    await runChat({
      cwd: enterProjectRoot(opts.cwd),
      ...(agent ? { agentId: agent } : {}),
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.session ? { session: opts.session } : {}),
    })
  })

program
  .command('invoke <agent> [input]')
  .description('Run an agent once (non-interactive, no human-in-the-loop)')
  .option('--skill <skill>', 'Skill to scope the run')
  .option('-s, --session <id>', 'Session id to attach the run to')
  .option('--json', 'Print the final structured output instead of streamed text')
  .option('--trace', 'Print tool calls to stderr as they happen')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (agent, input, opts) => {
    const resolved = input ?? (process.stdin.isTTY ? undefined : await readStdin())
    if (resolved === undefined || resolved === '') {
      console.error('[bread] No input provided. Pass it as an argument or pipe it via stdin.')
      process.exit(1)
    }
    await runInvoke({
      cwd: enterProjectRoot(opts.cwd),
      agentId: agent,
      input: resolved,
      json: Boolean(opts.json),
      trace: Boolean(opts.trace),
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.session ? { session: opts.session } : {}),
    })
  })

const sessions = program.command('sessions').description('Manage sessions')

sessions
  .command('list')
  .description('List sessions')
  .option('--tag <kv>', 'Filter by tag (key=value)')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await listSessions({ cwd: enterProjectRoot(opts.cwd), tag: opts.tag })
  })

sessions
  .command('cleanup')
  .description(
    'Bulk delete sessions (run while the server is stopped — concurrent writes to the same SQLite file can cause SQLITE_BUSY)',
  )
  .option('--older-than <days>', 'Delete sessions older than N days')
  .option('--tag <kv>', 'Filter by tag (key=value)')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await cleanupSessions({
      cwd: enterProjectRoot(opts.cwd),
      ...(opts.olderThan ? { olderThanDays: parseInt(opts.olderThan, 10) } : {}),
      tag: opts.tag,
    })
  })

const provider = program.command('provider').description('Manage LLM providers from the catalog')

provider
  .command('list')
  .description('List catalog providers with install/env status for this project')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (opts) => {
    await runProviderList({ cwd: enterProjectRoot(opts.cwd) })
  })

provider
  .command('add <name>')
  .description('Install a catalog provider\'s peer package and show required env vars')
  .option('--cwd <dir>', 'Project root directory', process.cwd())
  .action(async (name, opts) => {
    await runProviderAdd({ cwd: enterProjectRoot(opts.cwd), name })
  })

export function run() {
  program.parseAsync(process.argv).catch((err) => {
    console.error('[bread]', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
