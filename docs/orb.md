# Orb

`@breadai/ui-orb` is a WebGPU-rendered liquid orb that visualizes an agent's `idle`/`thinking`
status — bread's brand amber/cream/ink palette by default, framework-agnostic, and safe to use
more than once on a page.

<div class="bread-orb-demo">
  <bread-orb id="bread-orb-demo" state="idle"></bread-orb>
  <div class="bread-orb-demo-controls">
    <button type="button" data-orb-state="idle" class="active">Idle</button>
    <button type="button" data-orb-state="thinking">Thinking</button>
  </div>
</div>

Requires a WebGPU-capable browser. If nothing renders above, your browser (or this preview
environment) doesn't support WebGPU yet.

## Install

```bash
bun add @breadai/ui-orb   # or: npm i @breadai/ui-orb
```

## Usage

The low-level factory works with any framework, or none:

```ts
import { createBreadOrb } from '@breadai/ui-orb'

const canvas = document.querySelector('canvas')!
const orb = createBreadOrb(canvas, { initialState: 'idle' })

orb.setState('thinking') // eases into the active state
orb.destroy()            // stops the render loop, releases the GPU device
```

Or register the custom element once and drop `<bread-orb>` in anywhere — plain HTML, Vue
templates, React JSX intrinsics:

```ts
import { registerBreadOrbElement } from '@breadai/ui-orb'

registerBreadOrbElement() // never runs automatically on import
```

```html
<bread-orb state="idle" style="width: 96px; height: 96px"></bread-orb>
```

Set `state="thinking"` (or `.setAttribute('state', 'thinking')`) to trigger the transition; size
the element via CSS.

## Credits

The WebGPU rendering engine and shader are adapted from the
[Liquid Orb Editor](https://github.com/LerSent001/orb) by **LerSent001** (MIT licensed) — bread's
palette and flow preset were customized from an export produced by that editor. All credit for the
underlying optical/fluid shader work belongs to the original project.
