<template>
  <div v-html="svg"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { mermaidDiagramConfig } from '../config.mts'

const props = defineProps<{ graph: string }>()
const svg = ref('')
let observer: MutationObserver | null = null
let renderSeq = 0

async function renderChart(): Promise<void> {
  const seq = ++renderSeq
  const { default: mermaid } = await import('mermaid')
  const dark = document.documentElement.classList.contains('dark')
  mermaid.initialize({
    startOnLoad: false,
    ...mermaidDiagramConfig,
    theme: dark ? 'dark' : mermaidDiagramConfig.theme,
  })
  const id = `bread-mermaid-${seq.toString(36)}-${Math.random().toString(36).slice(2)}`
  const { svg: rendered } = await mermaid.render(id, decodeURIComponent(props.graph))
  if (seq !== renderSeq) return
  // v-html skips the update when the svg string is unchanged. A hidden salt
  // forces the redraw after a theme toggle, matching the old plugin.
  const salt = Math.random().toString(36).slice(2)
  svg.value = `${rendered}<span style="display:none">${salt}</span>`
}

onMounted(() => {
  observer = new MutationObserver(() => {
    void renderChart()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  void renderChart()
})

onUnmounted(() => observer?.disconnect())
</script>
