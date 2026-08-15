# bread — brand assets

The bread logo: a lowercase **“b” built as a square bread loaf**. Geometric, two-tone.
**Dark is the primary theme** (cream `#F4E6CC` stem + amber `#E7A64A` loaf); light is the alternative
(ink `#23201E` stem + amber `#E0913B` loaf).

## Files

| File | What | Use |
|------|------|-----|
| `bread-mark-dark.svg` | Bare mark, transparent bg, cream + amber | **Primary.** Dark UIs, README on dark, social |
| `bread-mark-light.svg` | Bare mark, transparent bg, ink + amber | Alternative for light backgrounds |
| `bread-icon.svg` | Self-contained tile: mark on a dark rounded square | Master for favicons & app icons |
| `favicon.ico` | Multi-res 16/32/48 | Browser tab |
| `favicon-16.png` · `favicon-32.png` | Small PNG favicons | `<link rel="icon">` |
| `apple-touch-icon.png` | 180×180, opaque tile | iOS home screen |
| `icon-192.png` · `icon-512.png` | PWA / app icons | `manifest.json` |
| `mark-dark-512.png` | Transparent bare mark, 512 | README header, OG image base |

## Palette

| Token | Hex |
|-------|-----|
| Amber crust (primary) | `#E7A64A` |
| Amber crust (light theme) | `#E0913B` |
| Cream (dark-theme ink) | `#F4E6CC` |
| Ink (light-theme) | `#23201E` |
| Dark tile background | `#15120E` |

## Regenerating rasters

The SVGs are the source of truth. To re-derive the PNGs and `.ico` (needs `rsvg-convert` + ImageMagick):

```bash
rsvg-convert -w 512 -h 512 bread-icon.svg -o icon-512.png
rsvg-convert -w 192 -h 192 bread-icon.svg -o icon-192.png
rsvg-convert -w 180 -h 180 bread-icon.svg -o apple-touch-icon.png
rsvg-convert -w 32  -h 32  bread-icon.svg -o favicon-32.png
rsvg-convert -w 16  -h 16  bread-icon.svg -o favicon-16.png
rsvg-convert -w 512 -h 512 bread-mark-dark.svg -o mark-dark-512.png
rsvg-convert -w 256 -h 256 bread-icon.svg -o _ico.png
magick _ico.png -define icon:auto-resize=48,32,16 favicon.ico && rm _ico.png
```
