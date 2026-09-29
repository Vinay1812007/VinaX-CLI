# VinaX brand

VinaX is your AI coding agent for the terminal. These assets keep it recognisable everywhere it
appears: the terminal, the docs site, the README and release pages.

| File                  | Use                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `vinax-mark.svg`      | The VX mark on its dark tile. App icons, favicons, social cards.                           |
| `vinax-mark-mono.svg` | One-colour mark (`currentColor`), for light backgrounds, print and places that tint icons. |
| `vinax-wordmark.svg`  | Mark plus the "VinaX" name. README and docs headers; adapts to light and dark themes.      |

## The mark

A geometric **V** and **X** drawn with the same round-capped strokes: the V in teal, the X in a
lighter teal, on a near-black tile with rounded corners. Keep clear space of at least a quarter of
the mark's width around it, and don't stretch, rotate or recolour the strokes.

## Colours

| Token         | Hex       | Where                                      |
| ------------- | --------- | ------------------------------------------ |
| Teal (accent) | `#14B8A6` | The V, the CLI accent colour, links        |
| Light teal    | `#5EEAD4` | The X, highlights on dark backgrounds      |
| Deep teal     | `#0D9488` | Accent on light backgrounds                |
| Ink           | `#0B1117` | Tile background, text on light backgrounds |
| Paper         | `#E6EDF3` | Text on dark backgrounds                   |

The terminal themes in `packages/cli/src/ui/theme.ts` use the same accent (`#14B8A6` dark,
`#0F766E` light).

## In the terminal

The CLI draws a two-row mark with box-drawing diagonals, so it works in any font and at any size:

```
╲  ╱ ╲╱   VinaX v0.1.0
 ╲╱  ╱╲   AI coding agent for the terminal
```

- `TERM=dumb` gets an ASCII version (`\  / \/` over ` \/  /\`).
- Windows narrower than 40 columns drop the mark and show `VX VinaX` on one line.
- With `NO_COLOR` set the mark is drawn without colour; its shape carries the identity.

The source is `packages/cli/src/ui/brand.ts`.
