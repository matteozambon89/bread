<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/ui-orb

A WebGPU-rendered liquid orb that visualizes an `idle`/`thinking` status — bread's brand
amber/cream/ink palette by default, framework-agnostic, and safe to use more than once on a page.

```bash
bun add @breadai/ui-orb   # or: npm i @breadai/ui-orb
```

Low-level factory — works with any framework, or none:

```ts
import { createBreadOrb } from '@breadai/ui-orb'

const canvas = document.querySelector('canvas')!
const orb = createBreadOrb(canvas, { initialState: 'idle' })

orb.setState('thinking') // eases into the active state
orb.getState()           // 'thinking'
orb.destroy()            // stops the render loop, releases the GPU device
```

Or the custom element — register it once, then use `<bread-orb>` anywhere (plain HTML, Vue
templates, React JSX intrinsics):

```ts
import { registerBreadOrbElement } from '@breadai/ui-orb'

registerBreadOrbElement() // never runs automatically on import
```

```html
<bread-orb state="idle" style="width: 96px; height: 96px"></bread-orb>
```

Set `state="thinking"`/`.setAttribute('state', 'thinking')` to trigger the transition; size it via
CSS on the element itself.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [orb](https://github.com/matteozambon89/bread/blob/HEAD/docs/orb.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## Credits

The WebGPU rendering engine and shader are adapted from the
[Liquid Orb Editor](https://github.com/LerSent001/orb) by **LerSent001** (MIT licensed) — bread's
palette and flow preset were customized from an export produced by that editor. All credit for the
underlying optical/fluid shader work belongs to the original project.

## License

MIT © Matteo Zambon
