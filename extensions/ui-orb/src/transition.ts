import type { BreadOrbState } from './types'
import { ACTIVATION_DURATION_MS, SETTLE_DURATION_MS } from './presets'

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
}

export function mixSrgb(from: number, to: number, progress: number): number {
  return linearToSrgb(srgbToLinear(from) + (srgbToLinear(to) - srgbToLinear(from)) * progress)
}

/** Color quads start at uniform index 40; the 4th component of each (alpha) isn't gamma-encoded. */
const COLOR_QUAD_START_INDEX = 40

function isColorComponent(index: number): boolean {
  return index >= COLOR_QUAD_START_INDEX && (index - COLOR_QUAD_START_INDEX) % 4 < 3
}

function easeTransitionProgress(raw: number, targetState: BreadOrbState): number {
  // "thinking" eases in fast (ease-out cubic); settling back to "idle" eases both ways (smoothstep).
  return targetState === 'thinking' ? 1 - (1 - raw) ** 3 : raw * raw * (3 - 2 * raw)
}

export type TransitionController = {
  /** The orb's current (possibly mid-transition) state. */
  getState: () => BreadOrbState
  /** Starts an eased transition toward `next`. Throws if `next` has no preset. */
  setState: (next: BreadOrbState) => void
  /** Samples the interpolated uniform values at time `now` (ms, `performance.now()` scale). */
  sampleTransition: (now: number) => Float32Array
}

/**
 * Per-instance state/color interpolator between two uniform presets. Pure —
 * no GPU or DOM access — so multiple orbs never share this state.
 */
export function createTransitionController(
  presets: Readonly<Record<BreadOrbState, Float32Array>>,
  initialState: BreadOrbState,
): TransitionController {
  let state = initialState
  let transitionTargetState: BreadOrbState = initialState
  let fromUniforms = new Float32Array(presets[initialState])
  let targetUniforms = new Float32Array(presets[initialState])
  const displayedUniforms = new Float32Array(presets[initialState])
  let transitionStartedAt = 0
  let activeTransitionDuration = 0

  function transitionProgress(now: number): number {
    if (activeTransitionDuration === 0) return 1
    const raw = Math.min(1, Math.max(0, (now - transitionStartedAt) / activeTransitionDuration))
    return easeTransitionProgress(raw, transitionTargetState)
  }

  function sampleTransition(now: number): Float32Array {
    const progress = transitionProgress(now)
    // Index 0-2 (width/height/motion phase) are written per-frame by the renderer, not interpolated here.
    for (let index = 3; index < displayedUniforms.length; index += 1) {
      const from = fromUniforms[index]!
      const to = targetUniforms[index]!
      displayedUniforms[index] = isColorComponent(index)
        ? mixSrgb(from, to, progress)
        : from + (to - from) * progress
    }
    return displayedUniforms
  }

  function setState(nextState: BreadOrbState): void {
    if (!Object.prototype.hasOwnProperty.call(presets, nextState)) {
      throw new TypeError(`Unknown bread orb state: ${String(nextState)}`)
    }
    if (nextState === state) return

    const now = performance.now()
    sampleTransition(now)
    fromUniforms = new Float32Array(displayedUniforms)
    targetUniforms = new Float32Array(presets[nextState])
    transitionTargetState = nextState
    transitionStartedAt = now
    activeTransitionDuration = nextState === 'thinking' ? ACTIVATION_DURATION_MS : SETTLE_DURATION_MS
    state = nextState
  }

  return {
    getState: () => state,
    setState,
    sampleTransition,
  }
}
