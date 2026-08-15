// Client-only: wraps each rendered mermaid diagram with an expand button that
// opens it in a fullscreen overlay with drag-to-pan and wheel/button zoom.
// vitepress-plugin-mermaid re-renders a diagram's innerHTML (v-html) on every
// light/dark toggle, so this watches the DOM instead of hooking the plugin —
// the wrapper + button survive because they sit outside the div it rewrites.

let observer: MutationObserver | null = null
let scanQueued = false

let lightboxEl: HTMLDivElement | null = null
let stageEl: HTMLDivElement | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let panZoomInstance: any = null
let cloneIdSeq = 0

// svg-pan-zoom touches `window` at module-evaluation time (not just when
// called), which crashes VitePress's Node-side SSR build on a static import —
// dynamic import keeps it out of that pass entirely, since this only runs
// from a click handler that itself never exists server-side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svgPanZoomFn: any = null
async function loadSvgPanZoom() {
  if (!svgPanZoomFn) {
    svgPanZoomFn = (await import('svg-pan-zoom')).default
  }
  return svgPanZoomFn
}

function buildLightbox(): void {
  if (lightboxEl) return

  lightboxEl = document.createElement('div')
  lightboxEl.className = 'bread-mermaid-lightbox'
  lightboxEl.hidden = true
  lightboxEl.setAttribute('role', 'dialog')
  lightboxEl.setAttribute('aria-modal', 'true')
  lightboxEl.setAttribute('aria-label', 'Diagram, zoomed view')
  lightboxEl.innerHTML = `
    <div class="bread-mermaid-lightbox-backdrop" data-action="close"></div>
    <div class="bread-mermaid-lightbox-panel">
      <div class="bread-mermaid-lightbox-toolbar">
        <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
        <button type="button" data-action="reset" aria-label="Reset zoom">Reset</button>
        <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" data-action="close" aria-label="Close">Close</button>
      </div>
      <div class="bread-mermaid-lightbox-stage"></div>
    </div>
  `
  document.body.appendChild(lightboxEl)
  stageEl = lightboxEl.querySelector('.bread-mermaid-lightbox-stage')

  lightboxEl.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action')
    if (action === 'close') closeLightbox()
    else if (action === 'zoom-in') panZoomInstance?.zoomIn()
    else if (action === 'zoom-out') panZoomInstance?.zoomOut()
    else if (action === 'reset') panZoomInstance?.reset()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightboxEl && !lightboxEl.hidden) closeLightbox()
  })
}

// Mermaid assigns element ids (arrowheads, gradients, clip paths) referenced
// via url(#id)/href="#id" within the same SVG. Cloning into the lightbox
// without renaming them would collide with the still-mounted original and
// silently break markers/refs there — so every id is suffixed and every
// reference to it rewritten in lockstep.
function cloneSvgWithFreshIds(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const suffix = `-lb${cloneIdSeq++}`
  const idMap = new Map<string, string>()

  clone.querySelectorAll('[id]').forEach((el) => {
    const oldId = el.getAttribute('id')
    if (!oldId) return
    const newId = oldId + suffix
    idMap.set(oldId, newId)
    el.setAttribute('id', newId)
  })

  const rewriteUrlRefs = (value: string) =>
    value.replace(/url\(#([^)]+)\)/g, (match, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : match))

  clone.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (attr.value.includes('url(#')) el.setAttribute(attr.name, rewriteUrlRefs(attr.value))
      if ((attr.name === 'href' || attr.name === 'xlink:href') && attr.value.startsWith('#')) {
        const target = idMap.get(attr.value.slice(1))
        if (target) el.setAttribute(attr.name, `#${target}`)
      }
    })
  })

  return clone
}

async function openLightbox(svg: SVGSVGElement): Promise<void> {
  buildLightbox()
  if (!lightboxEl || !stageEl) return

  stageEl.innerHTML = ''
  const clone = cloneSvgWithFreshIds(svg)
  clone.removeAttribute('style')
  clone.style.width = '100%'
  clone.style.height = '100%'
  stageEl.appendChild(clone)

  lightboxEl.hidden = false
  document.body.style.overflow = 'hidden'

  const svgPanZoom = await loadSvgPanZoom()
  requestAnimationFrame(() => {
    panZoomInstance = svgPanZoom(clone, {
      zoomEnabled: true,
      panEnabled: true,
      controlIconsEnabled: false,
      fit: true,
      center: true,
      minZoom: 0.3,
      maxZoom: 14,
      zoomScaleSensitivity: 0.3,
    })
  })
}

function closeLightbox(): void {
  if (!lightboxEl) return
  panZoomInstance?.destroy()
  panZoomInstance = null
  lightboxEl.hidden = true
  document.body.style.overflow = ''
}

function decorate(mermaidDiv: HTMLElement): void {
  if (mermaidDiv.dataset.breadDecorated) return
  const svg = mermaidDiv.querySelector('svg')
  if (!svg) return
  mermaidDiv.dataset.breadDecorated = 'true'

  const wrap = document.createElement('div')
  wrap.className = 'bread-mermaid-wrap'
  mermaidDiv.parentNode?.insertBefore(wrap, mermaidDiv)
  wrap.appendChild(mermaidDiv)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'bread-mermaid-expand'
  button.title = 'Open fullscreen, pan and zoom'
  button.setAttribute('aria-label', 'Open diagram fullscreen, pan and zoom')
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"/></svg>'
  button.addEventListener('click', () => {
    const currentSvg = mermaidDiv.querySelector('svg')
    if (currentSvg) openLightbox(currentSvg)
  })
  wrap.appendChild(button)
}

function scan(): void {
  scanQueued = false
  document.querySelectorAll<HTMLElement>('.vp-doc .mermaid').forEach((el) => {
    if (el.querySelector('svg')) decorate(el)
  })
}

function queueScan(): void {
  if (scanQueued) return
  scanQueued = true
  requestAnimationFrame(scan)
}

export function setupMermaidInteractive(): void {
  if (typeof window === 'undefined' || observer) return

  observer = new MutationObserver(queueScan)
  observer.observe(document.body, { childList: true, subtree: true })
  queueScan()
}
