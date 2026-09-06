/** The orb's two visual states — an at-rest indicator and an active one. */
export type BreadOrbState = 'idle' | 'thinking'

export type BreadOrbOptions = {
  /** State to render on the very first frame. Default: `'idle'`. */
  initialState?: BreadOrbState
  /** Override the shipped bread preset for one or both states. */
  presets?: Partial<Record<BreadOrbState, Float32Array>>
  /** Override the shipped WGSL shader. Escape hatch for custom flow presets. */
  shaderSource?: string
  /** Caps `devicePixelRatio` before sizing the canvas backing store. Default: 2. */
  devicePixelRatioCap?: number
  /** Called on any unrecoverable render error (missing WebGPU, device loss, shader error). */
  onError?: (error: Error) => void
}

export type BreadOrbHandle = {
  /** The orb's current (possibly mid-transition) state. */
  getState: () => BreadOrbState
  /** Starts an eased transition toward the given state. */
  setState: (next: BreadOrbState) => void
  /** Stops the render loop and releases the GPU device. Safe to call more than once. */
  destroy: () => void
}
