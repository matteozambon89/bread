import { z } from 'zod'
import { generateAndStoreImage } from './image-generate.js'
import { resolveImageModel, type ImageRegistry } from './image.js'
import type { BlobStore, FileOutput } from './storage/blob-store.js'
import { BreadError, type ImageTaskDefinition, type ToolContext, type ToolDefinition } from './types.js'

const promptSchema = z.object({
  prompt: z.string().describe('Text prompt for the image'),
})

export function createImageTaskTool(
  def: ImageTaskDefinition,
  deps: { image?: ImageRegistry | undefined; blobStore?: BlobStore | undefined },
): ToolDefinition<{ prompt: string }, FileOutput> {
  const cfg = def.config
  return {
    name: cfg.name,
    description: cfg.description,
    schema: promptSchema,
    async execute(args, ctx: ToolContext): Promise<FileOutput> {
      const prompt = args.prompt
      if (prompt.trim() === '') {
        throw new BreadError(
          `Image task "${cfg.name}" prompt must be a non-empty string.`,
          'IMAGE_PROMPT',
          { taskName: cfg.name },
        )
      }
      if (!deps.blobStore) {
        throw new BreadError(
          `Image task "${cfg.name}" needs a blobStore — see docs/store.md#blob-storage`,
          'BLOB_STORE_NOT_CONFIGURED',
          { taskName: cfg.name },
        )
      }
      const model = await resolveImageModel(deps.image, cfg.provider, cfg.model)
      const stored = await generateAndStoreImage({
        model,
        prompt,
        blobStore: deps.blobStore,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (stored.status === 'aborted') {
        throw new BreadError('run cancelled', 'RUN_CANCELLED', { taskName: cfg.name })
      }
      if (stored.status === 'failed') {
        const error = stored.error
        if (error instanceof BreadError) throw error
        throw new BreadError(
          error instanceof Error ? error.message : String(error),
          'TASK_ERROR',
          { taskName: cfg.name },
          error,
        )
      }
      return stored.file
    },
  }
}
