type FenceToken = { info: string; content: string }

type FenceRenderer = (
  tokens: FenceToken[],
  idx: number,
  options: unknown,
  env: unknown,
  self: { renderToken: (tokens: FenceToken[], idx: number, options: unknown) => string },
) => string

// VitePress compiles this string as a Vue template, so the tag stays Mermaid.
export function useMermaidFence(md: { renderer: { rules: { fence?: FenceRenderer } } }): void {
  const renderFence = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token || token.info.trim() !== 'mermaid') {
      if (!renderFence) return self.renderToken(tokens, idx, options)
      return renderFence(tokens, idx, options, env, self)
    }
    return `<Mermaid class="mermaid" graph="${encodeURIComponent(token.content)}"></Mermaid>`
  }
}
