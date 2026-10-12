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

Push reviewed code to `main`. CI must pass on Ubuntu, macOS and Windows, including the standalone binary smoke test. The release workflow then publishes a new patch version automatically when code changed since the current release. Documentation-only changes do not require a new package. A manually increased package version is respected for minor or major releases.

Only `@sirimillavinay/vinax` is published. Private core packages are bundled into it.

## What the workflows do

- **`ci.yml`** builds, typechecks and tests every push and pull request on three operating systems. Linux also checks lint, formatting, documentation and the standalone binary.
- **`release.yml`** runs after successful CI on a push to `main`. It verifies that the tested commit is still current, prepares the next patch version and changelog, and commits only release metadata. It publishes npm with provenance, builds and signs binaries from the same release commit, checks their versions, then attaches binaries and checksums to `v<version>`. A failed CI run cannot publish a release. A failed release can be retried using GitHub Actions' re-run action.
- **`deploy-gateway.yml`** calls the optional Render deploy hook after CI passes.

The repository must allow GitHub Actions to push release metadata to `main`. The release commit is made with `GITHUB_TOKEN`, which prevents a recursive workflow run.

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
