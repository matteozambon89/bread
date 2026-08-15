// Mirrors bread's public docs (README, CLAUDE.md, docs/*.md) into the user's
// Obsidian vault under Projects/bread/, adding frontmatter and rewriting
// cross-doc relative links into [[wikilinks]]. One-directional: always
// overwrites the vault copy, so hand-edits made there don't survive a re-run.
//
//   bun scripts/sync-obsidian.ts [vaultPath]
import { join, dirname, relative, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'

const repoRoot = resolve(import.meta.dir, '..')

async function resolveVaultPath(override?: string): Promise<string> {
  if (override) return override
  const configPath = join(homedir(), 'Library/Application Support/obsidian/obsidian.json')
  const config = (await Bun.file(configPath).json()) as {
    vaults: Record<string, { path: string }>
  }
  const vaults = Object.values(config.vaults)
  if (vaults.length === 0) throw new Error(`no vaults registered in ${configPath}`)
  return vaults[0]!.path
}

const sourcePaths = [
  'README.md',
  'CLAUDE.md',
  ...readdirSync(join(repoRoot, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
]

const noteNameByAbsPath = new Map(
  sourcePaths.map((p) => [resolve(repoRoot, p), p.replace(/\.md$/, '').split('/').pop()!]),
)

// Source docs are hard-wrapped at ~100 cols with bare newlines between
// wrapped lines of the same paragraph. GitHub collapses those into flowing
// text, but Obsidian's renderer treats a bare newline as a visible line
// break, so every wrap boundary shows up as a break mid-sentence. Join plain
// prose blocks into one line each; leave code fences, tables, lists,
// blockquotes, headings, and HTML blocks untouched.
const BLOCK_MARKER = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)/
const HORIZONTAL_RULE = /^(-{3,}|\*{3,}|_{3,})$/

function isPlainProseBlock(block: string[]): boolean {
  return block.every((line) => {
    const trimmed = line.trim()
    return !BLOCK_MARKER.test(trimmed) && !HORIZONTAL_RULE.test(trimmed) && !trimmed.startsWith('<')
  })
}

function unwrapParagraphs(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const fenceMatch = lines[i]!.match(/^(```|~~~)/)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      out.push(lines[i]!)
      i++
      while (i < lines.length && !lines[i]!.startsWith(marker)) {
        out.push(lines[i]!)
        i++
      }
      if (i < lines.length) {
        out.push(lines[i]!)
        i++
      }
      continue
    }
    if (lines[i]!.trim() === '') {
      out.push(lines[i]!)
      i++
      continue
    }
    const block: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(```|~~~)/.test(lines[i]!)) {
      block.push(lines[i]!)
      i++
    }
    out.push(isPlainProseBlock(block) ? block.map((l) => l.trim()).join(' ') : block.join('\n'))
  }
  return out.join('\n')
}

function rewriteLinks(content: string, sourceAbsPath: string): string {
  return content
    .split('\n')
    .map((line) => rewriteLineLinks(line, sourceAbsPath))
    .join('\n')
}

// A literal `|` inside a table cell is a column separator to Obsidian's table
// parser, so a wikilink alias (`[[name|text]]`) inside a table row must escape
// its pipe (`\|`) or the row gets cut off at the wikilink.
function rewriteLineLinks(line: string, sourceAbsPath: string): string {
  const isTableRow = /^\s*\|/.test(line)
  return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (match, bang, text, target) => {
    if (bang || /^[a-z]+:\/\//i.test(target) || target.startsWith('#')) return match
    const targetAbsPath = resolve(dirname(sourceAbsPath), target)
    const name = noteNameByAbsPath.get(targetAbsPath)
    if (!name) return match
    if (!text || text === name) return `[[${name}]]`
    return `[[${name}${isTableRow ? '\\|' : '|'}${text}]]`
  })
}

function frontmatter(sourceRelPath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const title = heading ?? sourceRelPath.replace(/\.md$/, '').split('/').pop()!
  const synced = new Date().toISOString().slice(0, 10)
  return `---\ntitle: ${title}\ntags:\n  - bread\nsource: ${sourceRelPath}\nsynced: ${synced}\n---\n\n`
}

async function main() {
  const vaultPath = await resolveVaultPath(process.argv[2])
  const destRoot = join(vaultPath, 'Projects', 'bread')

  for (const sourceRelPath of sourcePaths) {
    const sourceAbsPath = resolve(repoRoot, sourceRelPath)
    const raw = await Bun.file(sourceAbsPath).text()
    const unwrapped = unwrapParagraphs(raw)
    const body = rewriteLinks(unwrapped, sourceAbsPath)
    const out = frontmatter(sourceRelPath, raw) + body
    const destAbsPath = join(destRoot, sourceRelPath)
    await Bun.write(destAbsPath, out)
    console.log(`${sourceRelPath} → ${relative(vaultPath, destAbsPath)}`)
  }

  console.log(`\n${sourcePaths.length} file(s) synced to ${destRoot}`)
}

await main()
