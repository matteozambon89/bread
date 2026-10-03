import { cancel, confirm, intro, isCancel, outro, select, text } from '@clack/prompts'
import type { Ask, Prompt } from './prompt.js'

// One command asks several times. intro('bread') runs on the first prompt only.
let introduced = false

async function askClack(prompt: Prompt): Promise<unknown> {
  if (prompt.kind === 'select') {
    return select({
      message: prompt.message,
      options: prompt.options.map((option) => ({ value: option.value, label: option.label })),
      initialValue: prompt.initialValue,
    })
  }
  if (prompt.kind === 'confirm') {
    return confirm({
      message: prompt.message,
      initialValue: prompt.initialValue,
    })
  }
  return text({
    message: prompt.message,
    ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.initialValue !== undefined
      ? { initialValue: prompt.initialValue, defaultValue: prompt.initialValue }
      : {}),
  })
}

// isCancel exits 0 before the caller writes. A cancel during questions leaves
// the directory unchanged; a later failure can only happen after runInit.
export const clackAsk: Ask = async (prompt) => {
  if (!introduced) {
    intro('bread')
    introduced = true
  }
  const value = await askClack(prompt)
  if (isCancel(value)) {
    cancel('Cancelled.')
    process.exit(0)
  }
  return value
}

// A status line does not take raw mode. Clack's block() does, and its cancel
// key calls process.exit(0), which does not signal a piped child.
export async function withStatus<T>(message: string, task: () => Promise<T>): Promise<T> {
  process.stdout.write(`${message}\n`)
  return task()
}

export function finishWizard(message: string): void {
  outro(message)
}
