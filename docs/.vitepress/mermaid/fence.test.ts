import { describe, expect, test } from 'bun:test'
import { mermaidInitializeConfig } from './initialize.ts'
import { useMermaidFence } from './fence.ts'

type Token = { info: string; content: string }
type Self = {
  renderToken: (tokens: Token[], idx: number, options: unknown) => string
}
type FenceRule = (
  tokens: Token[],
  idx: number,
  options: unknown,
  env: unknown,
  self: Self,
) => string

function render(rules: { fence?: FenceRule }, tokens: Token[], self: Self): string {
  const md = { renderer: { rules } }
  useMermaidFence(md)
  const fence = md.renderer.rules.fence
  if (!fence) throw new Error('useMermaidFence did not install a fence rule')
  return fence(tokens, 0, {}, {}, self)
}

describe('useMermaidFence', () => {
  test('renders a mermaid fence as a Mermaid component', () => {
    const source = 'graph TD\n  A["x & y"] --> B'
    const html = render(
      { fence: () => 'previous' },
      [{ info: ' mermaid ', content: source }],
      { renderToken: () => 'token' },
    )
    expect(html).toBe(
      `<Mermaid class="mermaid" graph="${encodeURIComponent(source)}"></Mermaid>`,
    )
  })

  test('keeps the previous renderer for other fences', () => {
    const html = render(
      { fence: (tokens) => `previous:${tokens[0]?.info}` },
      [{ info: 'ts', content: 'const n = 1' }],
      { renderToken: () => 'token' },
    )
    expect(html).toBe('previous:ts')
  })

  test('falls back to renderToken when no fence rule exists', () => {
    const html = render({}, [{ info: 'ts', content: '1' }], {
      renderToken: (tokens) => `token:${tokens[0]?.info}`,
    })
    expect(html).toBe('token:ts')
  })
})

describe('mermaidInitializeConfig', () => {
  test('pins layout to dagre and look to classic', () => {
    for (const dark of [false, true]) {
      const config = mermaidInitializeConfig(dark)
      expect(config.layout).toBe('dagre')
      expect(config.look).toBe('classic')
    }
  })
})
