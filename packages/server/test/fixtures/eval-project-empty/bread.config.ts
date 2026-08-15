import { defineConfig } from '@bread/core'

// No *.eval.ts anywhere under agents/ — exercises runEvalCommand's "No eval
// files found" early-return branch. No store/providers needed: the command
// returns before ever calling createBread.
export default defineConfig({ entrypoints: ['agent'] })
