import type { MermaidConfig } from 'mermaid'
import { mermaidDiagramConfig } from '../config.mts'

// renderChart passes this object to mermaid.initialize. The pin test reads it,
// so dropping the spread fails instead of leaving flowcharts on ELK and neo.
export function mermaidInitializeConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    ...mermaidDiagramConfig,
    theme: dark ? 'dark' : mermaidDiagramConfig.theme,
  }
}
