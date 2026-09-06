import { RIBBON_INSTANCE_COUNT, RIBBON_STYLE_INDEX } from './presets'

export type RendererOptions = {
  canvas: HTMLCanvasElement
  shaderSource: string
  /** Length of the packed uniform array (see presets.ts for the layout). */
  uniformLength: number
  /** Called once per frame; must return the interpolated uniforms for `now`. */
  sampleUniforms: (now: number) => Float32Array
  devicePixelRatioCap: number
  onError: (error: Error) => void
}

export type RendererHandle = {
  /** Stops the render loop and releases the GPU device. Safe to call more than once, and safe to call before the async WebGPU setup finishes. */
  destroy: () => void
}

const BLEND_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/**
 * Acquires a WebGPU device for `canvas` and starts the render loop. GPU
 * setup is asynchronous, so `destroy()` may be called before it resolves —
 * in that case the device is released as soon as it becomes available
 * rather than left dangling.
 */
export function startRenderer(options: RendererOptions): RendererHandle {
  const { canvas, shaderSource, uniformLength, sampleUniforms, devicePixelRatioCap, onError } = options

  let stopped = false
  let device: GPUDevice | null = null
  let animationFrame = 0
  let ribbonTarget: GPUTexture | null = null

  function reportError(error: unknown): void {
    onError(error instanceof Error ? error : new Error(String(error)))
  }

  function destroy(): void {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(animationFrame)
    ribbonTarget?.destroy()
    ribbonTarget = null
    device?.destroy()
  }

  function stopWithError(error: unknown): void {
    if (stopped) return
    destroy()
    reportError(error)
  }

  async function start(): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU is not supported in this environment.')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('No compatible WebGPU adapter was found.')
    const gpuDevice = await adapter.requestDevice()
    if (stopped) {
      gpuDevice.destroy()
      return
    }
    device = gpuDevice

    const rawContext = canvas.getContext('webgpu')
    if (!rawContext) throw new Error('Unable to create a WebGPU canvas context.')
    // Rebind with an explicit non-null type: TS control-flow narrowing above
    // doesn't survive into the `frame` closure declared further down.
    const canvasContext: GPUCanvasContext = rawContext

    const format = navigator.gpu.getPreferredCanvasFormat()
    canvasContext.configure({ device: gpuDevice, format, alphaMode: 'premultiplied' })
    const shader = gpuDevice.createShaderModule({ code: shaderSource })
    const compilation = await shader.getCompilationInfo()
    const errors = compilation.messages.filter((message) => message.type === 'error')
    if (errors.length) {
      throw new Error(
        errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'),
      )
    }

    const pipeline = gpuDevice.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format, blend: BLEND_OVER }] },
      primitive: { topology: 'triangle-list' },
    })
    const ribbonPipeline = gpuDevice.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'ribbon_vs_main' },
      fragment: {
        module: shader,
        entryPoint: 'ribbon_fs_main',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    const ribbonCompositePipeline = gpuDevice.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: {
        module: shader,
        entryPoint: 'ribbon_composite_fs_main',
        targets: [{ format, blend: BLEND_OVER }],
      },
      primitive: { topology: 'triangle-list' },
    })

    const values = new Float32Array(uniformLength)
    const uniformBuffer = gpuDevice.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const bindGroup = gpuDevice.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })
    const ribbonBindGroup = gpuDevice.createBindGroup({
      layout: ribbonPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })
    const ribbonSampler = gpuDevice.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    })
    let ribbonCompositeBindGroup: GPUBindGroup | null = null
    let lastFrameAt: number | null = null
    let motionPhase = 0

    gpuDevice.lost.then((info) => {
      stopWithError(new Error(`WebGPU device lost: ${info.message || info.reason}`))
    })
    gpuDevice.addEventListener('uncapturederror', (event) => {
      const gpuEvent = event as GPUUncapturedErrorEvent
      gpuEvent.preventDefault()
      stopWithError(new Error(`WebGPU rendering error: ${gpuEvent.error.message}`))
    })

    function frame(now: number): void {
      if (stopped) return
      try {
        const dpr = Math.min(window.devicePixelRatio || 1, devicePixelRatioCap)
        const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
        const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
          ribbonTarget?.destroy()
          ribbonTarget = null
          ribbonCompositeBindGroup = null
        }

        values.set(sampleUniforms(now))
        const frameDelta = lastFrameAt === null ? 0 : Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000))
        lastFrameAt = now
        motionPhase += frameDelta * Math.max(values[3]!, 0)
        values[0] = width
        values[1] = height
        values[2] = motionPhase / Math.max(values[3]!, 0.001)
        gpuDevice.queue.writeBuffer(uniformBuffer, 0, values)

        const isParticleRibbon = Math.round(values[15]!) === RIBBON_STYLE_INDEX
        const encoder = gpuDevice.createCommandEncoder()
        if (isParticleRibbon) {
          if (!ribbonTarget || !ribbonCompositeBindGroup) {
            ribbonTarget = gpuDevice.createTexture({
              size: { width, height },
              format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
            ribbonCompositeBindGroup = gpuDevice.createBindGroup({
              layout: ribbonCompositePipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: ribbonTarget.createView() },
                { binding: 2, resource: ribbonSampler },
              ],
            })
          }
          const particlePass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: ribbonTarget.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
          particlePass.setPipeline(ribbonPipeline)
          particlePass.setBindGroup(0, ribbonBindGroup)
          particlePass.draw(6, RIBBON_INSTANCE_COUNT)
          particlePass.end()
        }

        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: canvasContext.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        if (isParticleRibbon && ribbonCompositeBindGroup) {
          pass.setPipeline(ribbonCompositePipeline)
          pass.setBindGroup(0, ribbonCompositeBindGroup)
        } else {
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bindGroup)
        }
        pass.draw(3)
        pass.end()
        gpuDevice.queue.submit([encoder.finish()])
        animationFrame = requestAnimationFrame(frame)
      } catch (error) {
        stopWithError(error)
      }
    }

    animationFrame = requestAnimationFrame(frame)
  }

  start().catch(stopWithError)

  return { destroy }
}
