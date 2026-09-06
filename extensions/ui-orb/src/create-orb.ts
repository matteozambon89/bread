import type { BreadOrbHandle, BreadOrbOptions, BreadOrbState } from './types'
import { createTransitionController } from './transition'
import { startRenderer } from './renderer'
import { orbShaderSource } from './shader'
import { defaultStatePresets } from './presets'

const DEFAULT_DEVICE_PIXEL_RATIO_CAP = 2

function noop(): void {}

/**
 * Creates one independent bread orb instance rendering into `canvas`. Safe
 * to call more than once on a page — nothing is shared globally, unlike the
 * single-instance `window.liquidOrb` the upstream editor's export produces.
 */
export function createBreadOrb(canvas: HTMLCanvasElement, options: BreadOrbOptions = {}): BreadOrbHandle {
  const initialState: BreadOrbState = options.initialState ?? 'idle'
  const presets: Record<BreadOrbState, Float32Array> = {
    idle: options.presets?.idle ?? defaultStatePresets.idle,
    thinking: options.presets?.thinking ?? defaultStatePresets.thinking,
  }
  const shaderSource = options.shaderSource ?? orbShaderSource
  const devicePixelRatioCap = options.devicePixelRatioCap ?? DEFAULT_DEVICE_PIXEL_RATIO_CAP
  const onError = options.onError ?? noop

  const transition = createTransitionController(presets, initialState)

  if (typeof navigator === 'undefined' || !navigator.gpu) {
    onError(new Error('WebGPU is not supported in this environment.'))
    return { getState: transition.getState, setState: transition.setState, destroy: noop }
  }

  const renderer = startRenderer({
    canvas,
    shaderSource,
    uniformLength: presets[initialState].length,
    sampleUniforms: (now) => transition.sampleTransition(now),
    devicePixelRatioCap,
    onError,
  })

  let destroyed = false
  function handlePageHide(): void {
    destroy()
  }
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    window.removeEventListener('pagehide', handlePageHide)
    renderer.destroy()
  }
  window.addEventListener('pagehide', handlePageHide, { once: true })

  return {
    getState: transition.getState,
    setState: transition.setState,
    destroy,
  }
}
