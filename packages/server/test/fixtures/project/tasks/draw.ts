import { defineImageTask } from '@breadai/core'

export default defineImageTask({
  name: 'draw',
  description: 'Draw an image from a text prompt',
  provider: 'openai',
  model: 'gpt-image-1',
})
