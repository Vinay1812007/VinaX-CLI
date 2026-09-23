# VinaX documentation

These pages are the source of the documentation site:
**https://vinay1812007.github.io/VinaX-CLI/**

It's built with [VitePress](https://vitepress.dev). Run it locally:

```sh
pnpm install
pnpm docs:dev       # live preview at http://localhost:5173/VinaX-CLI/
pnpm docs:build     # static site in docs/.vitepress/dist
```

The sidebar and navigation are set in `.vitepress/config.mts`, and the brand styles in `.vitepress/theme/custom.css`. Pushes to `main` that touch `docs/` deploy the site through `.github/workflows/docs.yml`. `PLAN.md` (the original design plan) and this file are not part of the site.
