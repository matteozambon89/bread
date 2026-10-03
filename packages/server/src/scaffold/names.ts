import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { BreadError } from '@breadai/core'

// Hyphens are allowed (ticket-lookup). Tool, skill, and eval names stay on
// assertName — those ids cannot contain '-'.
export const AGENT_ID_RE = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/

export function assertAgentId(id: string): void {
  if (!AGENT_ID_RE.test(id)) {
    throw new BreadError(
      `Agent id "${id}" must match ${AGENT_ID_RE} (lowercase, digits, single "_" or "-" separators).`,
      'SCAFFOLD_INVALID_NAME',
      { kind: 'agent', value: id },
    )
  }
}

export function packageNameFromDir(dir: string): string {
  return basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
