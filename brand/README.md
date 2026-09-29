# VinaX brand

VinaX is your AI coding agent for the terminal. The logo spells **VinaX** in striped block
letters in three bands, saffron, white and green, with a blue chakra in the "a".

| File                         | Use                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| `vinax-logo.svg`             | The full logo on a black tile. README, docs, release pages.           |
| `vinax-logo-transparent.svg` | The full logo without a background, for dark pages.                   |
| `vinax-logo-mono.svg`        | One colour (`currentColor`), for light backgrounds and print.         |
| `vinax-mark.svg`             | Just the "VX" letters on a square tile. Favicons, app icons, avatars. |
| `vinax-mark-mono.svg`        | One-colour square mark.                                               |

All of these are generated from the same letter grid the terminal draws, so they never drift
apart. After changing the letters in `packages/cli/src/ui/brand.ts`, run:

```bash
pnpm brand:build
```

It rewrites the files above and `docs/public/{logo,favicon,vinax-logo}.svg`.

## Colours

| Band          | Hex       | Notes                                               |
| ------------- | --------- | --------------------------------------------------- |
| Saffron       | `#FF9933` | Top three rows                                      |
| White         | `#F8FAFC` | Middle two rows; `#9CA3AF` on light terminal themes |
| Green         | `#3CB043` | Bottom two rows                                     |
| Chakra (blue) | `#1D4ED8` | The wheel inside the "a"                            |
| Background    | `#0A0A0A` | Tiles behind the logo                               |

The rest of the CLI keeps its teal accent (`#14B8A6`) for borders, links and highlights.

## In the terminal

The welcome screen draws the logo seven rows tall with `▀` characters, which show as horizontal
stripes, and the chakra as `✺`:

- Windows narrower than 51 columns show a one-line tricolor **VinaX** instead.
- `NO_COLOR` keeps the striped shapes without colour.
- `TERM=dumb` uses plain ASCII (`=` and `o`).
