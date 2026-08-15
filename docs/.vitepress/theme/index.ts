// theme-without-fonts: we reskin to a system font stack in custom.css, so the
// default theme's bundled Inter webfont would ship dead weight.
import DefaultTheme from 'vitepress/theme-without-fonts'
import { setupMermaidInteractive } from './mermaid-interactive'
import './custom.css'

// Reskin only — no Layout override, no markdown transforms. bread's docs/*.md
// content renders through VitePress's own default theme structure (nav, sidebar,
// content, outline); custom.css retargets its --vp-* tokens to the bread brand.
// enhanceApp only adds pan/zoom to already-rendered mermaid diagrams — see
// mermaid-interactive.ts.
export default {
  extends: DefaultTheme,
  enhanceApp() {
    setupMermaidInteractive()
  },
}
