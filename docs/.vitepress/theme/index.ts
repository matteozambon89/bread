// theme-without-fonts: we reskin to a system font stack in custom.css, so the
// default theme's bundled Inter webfont would ship dead weight.
import type { EnhanceAppContext } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import Mermaid from '../mermaid/Mermaid.vue'
import { setupMermaidInteractive } from './mermaid-interactive'
import { setupOrbDemo } from './orb-demo'
import './custom.css'

// Reskin only — no Layout override, no markdown transforms. bread's docs/*.md
// content renders through VitePress's own default theme structure (nav, sidebar,
// content, outline); custom.css retargets its --vp-* tokens to the bread brand.
// enhanceApp registers Mermaid, adds pan/zoom to rendered diagrams (see
// mermaid-interactive.ts), and mounts the live orb demo on docs/orb.md (see
// orb-demo.ts).
export default {
  extends: DefaultTheme,
  enhanceApp({ app }: EnhanceAppContext) {
    app.component('Mermaid', Mermaid)
    setupMermaidInteractive()
    setupOrbDemo()
  },
}
