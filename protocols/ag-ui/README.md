<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/protocol-ag-ui

Bridge bread's crumb stream to [AG-UI protocol](https://ag-ui.com) events, with spec-conformant
framing: `TEXT_MESSAGE_START/CONTENT/END` around assistant text, the full
`TOOL_CALL_START/ARGS/END/RESULT` lifecycle, `RUN_STARTED/FINISHED/ERROR` with `threadId`,
`STEP_STARTED/FINISHED` for pipeline steps and loop iterations, and `STATE_SNAPSHOT` for loop
state.

```bash
bun add @breadai/protocol-ag-ui   # or: npm i @breadai/protocol-ag-ui
```

```ts
import { defineConfig } from '@breadai/core'
import { agUi } from '@breadai/protocol-ag-ui'

export default defineConfig({
  entrypoints: ['assistant'],
  plugins: [
    agUi({ onEvent: (event) => transport.send(event) }), // your AG-UI client transport
  ],
})
```

`createAgUiTransformer()` is exported separately for building your own delivery (it's stateful —
one instance per stream).

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [ag-ui](https://github.com/matteozambon89/bread/blob/HEAD/docs/ag-ui.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
