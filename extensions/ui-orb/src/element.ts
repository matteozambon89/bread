import { createBreadOrb } from './create-orb'
import type { BreadOrbHandle, BreadOrbState } from './types'

const STATE_ATTRIBUTE = 'state'

function toOrbState(value: string | null): BreadOrbState {
  return value === 'thinking' ? 'thinking' : 'idle'
}

/**
 * `<bread-orb state="idle|thinking">` — a canvas-backed custom element
 * wrapping `createBreadOrb`. Sizes to its host element via CSS (set a
 * width/height on `<bread-orb>` itself). Not registered by importing this
 * module — call `registerBreadOrbElement()` explicitly.
 */
export class BreadOrbElement extends HTMLElement {
  #handle: BreadOrbHandle | null = null
  readonly #canvas: HTMLCanvasElement

  static get observedAttributes(): string[] {
    return [STATE_ATTRIBUTE]
  }

  constructor() {
    super()
    this.#canvas = document.createElement('canvas')
    this.#canvas.style.width = '100%'
    this.#canvas.style.height = '100%'
    this.#canvas.style.display = 'block'
  }

  connectedCallback(): void {
    this.appendChild(this.#canvas)
    this.#handle = createBreadOrb(this.#canvas, {
      initialState: toOrbState(this.getAttribute(STATE_ATTRIBUTE)),
    })
  }

  disconnectedCallback(): void {
    this.#handle?.destroy()
    this.#handle = null
    this.#canvas.remove()
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === STATE_ATTRIBUTE) this.#handle?.setState(toOrbState(newValue))
  }

  getState(): BreadOrbState {
    return this.#handle?.getState() ?? 'idle'
  }

  setState(next: BreadOrbState): void {
    this.setAttribute(STATE_ATTRIBUTE, next)
  }
}

/**
 * Registers `<bread-orb>` as a custom element. Never runs automatically on
 * import — this repo avoids auto-wired side effects, so call this once
 * yourself wherever the tag should become usable. Safe to call more than
 * once (e.g. across hot-module-reload).
 */
export function registerBreadOrbElement(tagName = 'bread-orb'): void {
  if (customElements.get(tagName)) return
  customElements.define(tagName, BreadOrbElement)
}
