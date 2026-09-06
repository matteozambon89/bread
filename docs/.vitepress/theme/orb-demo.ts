// Client-only: mounts a live <bread-orb> demo on docs/orb.md and wires its
// idle/thinking toggle buttons. @breadai/ui-orb's custom element extends
// HTMLElement at module scope, which throws under VitePress's Node-side SSR
// build on a static import — dynamic import keeps it out of that pass
// entirely, the same dodge mermaid-interactive.ts uses for svg-pan-zoom.
// The orb's own disconnectedCallback releases its GPU device when the SPA
// navigates away, so no teardown is needed here.

const DEMO_ELEMENT_ID = 'bread-orb-demo'

let observer: MutationObserver | null = null
let scanQueued = false
let registerOrbElement: (() => void) | null = null

async function ensureRegistered(): Promise<void> {
  if (!registerOrbElement) {
    const mod = await import('@breadai/ui-orb')
    registerOrbElement = mod.registerBreadOrbElement
  }
  registerOrbElement()
}

function wireControls(demo: HTMLElement): void {
  const controls = demo.closest('.bread-orb-demo')?.querySelector('.bread-orb-demo-controls')
  const buttons = controls?.querySelectorAll<HTMLButtonElement>('[data-orb-state]')
  buttons?.forEach((button) => {
    button.addEventListener('click', () => {
      demo.setAttribute('state', button.dataset.orbState === 'thinking' ? 'thinking' : 'idle')
      buttons.forEach((other) => other.classList.toggle('active', other === button))
    })
  })
}

function decorate(demo: HTMLElement): void {
  if (demo.dataset.breadDecorated) return
  demo.dataset.breadDecorated = 'true'
  wireControls(demo)
}

function scan(): void {
  scanQueued = false
  const demo = document.getElementById(DEMO_ELEMENT_ID)
  if (demo) void ensureRegistered().then(() => decorate(demo))
}

function queueScan(): void {
  if (scanQueued) return
  scanQueued = true
  requestAnimationFrame(scan)
}

export function setupOrbDemo(): void {
  if (typeof window === 'undefined' || observer) return
  observer = new MutationObserver(queueScan)
  observer.observe(document.body, { childList: true, subtree: true })
  queueScan()
}
