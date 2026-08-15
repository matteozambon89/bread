import { defineConfig } from '@bread/core'
import { store } from '@bread/store-memory'
import { transport } from '@bread/transport-stdout'
import { mockProvider, mockToolCallModel } from '@bread/test-utils'

// Fixture for packages/cli/test/chat.test.ts — a real `bread chat` subprocess
// against a scripted model, not a live provider. The model calls the human
// tool on turn one, then answers with `then` once the human's reply comes
// back as the tool result — exactly the two-turn shape resumeRun expects.
export default defineConfig({
  entrypoints: ['assistant'],
  store: store(),
  transport: transport(),
  providers: mockProvider({
    default: mockToolCallModel({
      toolName: 'human_ask_human',
      args: { question: 'What is your name?' },
      then: 'Thanks — got your answer.',
    }),
  }),
})
