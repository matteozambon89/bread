import { describe, expect, test } from 'bun:test'
import { createTransitionController, linearToSrgb, mixSrgb, srgbToLinear } from '../src/transition'
import type { BreadOrbState } from '../src/types'

const UNIFORM_LENGTH = 44 // 40 non-color floats + one RGBA color quad, enough to cover both branches
const ACTIVATION_DURATION_MS = 800 // must match transition.ts's ACTIVATION_DURATION_MS

function makePreset(fill: number, colorFill: number): Float32Array {
  const values = new Float32Array(UNIFORM_LENGTH).fill(fill)
  values.set([colorFill, colorFill, colorFill, colorFill], 40)
  return values
}

const presets: Record<BreadOrbState, Float32Array> = {
  idle: makePreset(0, 0),
  thinking: makePreset(1, 1),
}

describe('srgb round-trip', () => {
  test('linearToSrgb(srgbToLinear(x)) is the identity within floating-point tolerance', () => {
    for (const value of [0, 0.01, 0.2, 0.5, 0.8, 1]) {
      expect(linearToSrgb(srgbToLinear(value))).toBeCloseTo(value, 6)
    }
  })

  test('mixSrgb returns the endpoints at progress 0 and 1', () => {
    expect(mixSrgb(0.2, 0.9, 0)).toBeCloseTo(0.2, 6)
    expect(mixSrgb(0.2, 0.9, 1)).toBeCloseTo(0.9, 6)
  })
})

describe('createTransitionController', () => {
  test('setState throws on an unknown state', () => {
    const controller = createTransitionController(presets, 'idle')
    expect(() => controller.setState('glowing' as BreadOrbState)).toThrow(TypeError)
  })

  test('setState is a no-op when already in that state', () => {
    const controller = createTransitionController(presets, 'idle')
    controller.setState('idle')
    expect(controller.getState()).toBe('idle')
  })

  test('sampleTransition interpolates non-color values linearly and color values through sRGB', () => {
    const controller = createTransitionController(presets, 'idle')
    const startedAt = performance.now()
    controller.setState('thinking')

    // Halfway through the transition: linear index (3) reads ~0.5, but the
    // sRGB-mixed color index (40) doesn't — sRGB mixing is nonlinear.
    const midway = controller.sampleTransition(startedAt + ACTIVATION_DURATION_MS / 2)
    expect(midway[3]).toBeGreaterThan(0)
    expect(midway[3]).toBeLessThan(1)
    expect(midway[40]).not.toBeCloseTo(midway[3]!, 3)
  })

  test('transitioning to "thinking" then reaching progress 1 lands exactly on the thinking preset', () => {
    const controller = createTransitionController(presets, 'idle')
    const startedAt = performance.now()
    controller.setState('thinking')
    const settled = controller.sampleTransition(startedAt + ACTIVATION_DURATION_MS * 10)
    expect(settled[3]).toBeCloseTo(1, 6)
    expect(settled[40]).toBeCloseTo(1, 6)
  })
})
