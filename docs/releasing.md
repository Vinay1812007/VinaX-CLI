# Releasing

Releases are automated. This page is for maintainers.

## One-time setup

| Where                                  | What                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| npm                                    | An automation token for the `sirimillavinay` npm account                               |
| GitHub secret `NPM_TOKEN`              | That token                                                                             |
| GitHub settings                        | Actions → General → Workflow permissions: allow GitHub Actions to create pull requests |
| GitHub secret `RENDER_DEPLOY_HOOK_URL` | Optional: the gateway's Render deploy hook (see [gateway.md](gateway.md))              |

## Every change

Add a changeset with your pull request:

```sh
pnpm changeset          # pick the bump (patch / minor / major) and describe the change
```

Only the CLI is published, as `@sirimillavinay/vinax` (npm refused the plain name `vinax` as too similar to existing packages; the command is still `vinax`). Name it that way in changesets, e.g. `'@sirimillavinay/vinax': patch`. The private packages (`@vinax/core`, `@vinax/testkit` and
`@vinax/gateway`) are bundled or deployed, and never published.

## What the workflows do

- **`ci.yml`** runs on every push and pull request, on Ubuntu, macOS and Windows. It builds, then
  runs typecheck and tests. Lint and prettier run on Ubuntu. A separate job builds and runs a
  standalone Linux binary.
- **`release.yml`** runs on every push to `main`:
  1. [changesets/action](https://github.com/changesets/action) opens or updates a "Release vinax"
     pull request that bumps the version and writes `packages/cli/CHANGELOG.md`.
  2. When that PR is merged, the same workflow publishes `@sirimillavinay/vinax` to npm with provenance.
  3. After a publish, Bun builds the standalone binaries. Linux and Windows builds run on Ubuntu;
     macOS builds run on macOS, where they are ad-hoc signed. The workflow writes `SHA256SUMS`
     and creates the GitHub Release `v<version>` with every binary attached.
     `install.sh`, `install.ps1` and `vinax update` download from the latest release.
- **`deploy-gateway.yml`** calls the Render deploy hook after CI passes on `main`.

## Binaries

| Asset                     | Built with Bun target         |
| ------------------------- | ----------------------------- |
| `vinax-linux-x64`         | `bun-linux-x64-baseline`      |
| `vinax-linux-arm64`       | `bun-linux-arm64`             |
| `vinax-linux-x64-musl`    | `bun-linux-x64-musl-baseline` |
| `vinax-linux-arm64-musl`  | `bun-linux-arm64-musl`        |
| `vinax-darwin-x64`        | `bun-darwin-x64`              |
| `vinax-darwin-arm64`      | `bun-darwin-arm64`            |
| `vinax-windows-x64.exe`   | `bun-windows-x64-baseline`    |
| `vinax-windows-arm64.exe` | `bun-windows-arm64`           |

The x64 builds use Bun's "baseline" targets, so they also run on CPUs without AVX2. Each binary
knows its own target name, so `vinax update` fetches the matching asset. Build them locally with
`bun scripts/build-binaries.ts [targets…]`; the output goes to `dist-bin/`.

Two optional native modules are left out of the binaries, because they can't be embedded for other
platforms:

- **The OS keychain.** Keys go to `~/.vinax/credentials.json`, mode 0600.
- **Bundled ripgrep.** `Grep` uses `rg` from `PATH`, or its JavaScript search.

## A manual release

If the workflow can't publish (for example, before `NPM_TOKEN` exists):

```sh
pnpm changeset version && pnpm install    # bump and write the changelog
git commit -am "chore: release vinax" && git push
pnpm release                              # build + changeset publish (needs npm login)
```

Then build the binaries and create the release:

```sh
bun scripts/build-binaries.ts
cd dist-bin && shasum -a 256 vinax-* > SHA256SUMS
gh release create v<version> dist-bin/*
```
