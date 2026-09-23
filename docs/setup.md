# Install and set up

<p class="lead">Installation options, logging in, updating, uninstalling, and where VinaX keeps its files.</p>

## System requirements

|                  | Standalone binary                          | npm package                |
| ---------------- | ------------------------------------------ | -------------------------- |
| Operating system | macOS, Linux (glibc or musl), Windows      | Any system with Node.js    |
| CPU              | x64 or arm64                               | Any                        |
| Runtime          | None                                       | Node.js 22 or newer        |
| Optional         | `rg` (ripgrep) on `PATH` for faster search | Git, for git-related tasks |

On Windows, install [Git for Windows](https://git-scm.com/download/win). VinaX then runs commands in Git Bash, which models handle best; without it, it falls back to PowerShell.

## Install

::::tabs
== Install script
::: code-group

```bash [macOS, Linux]
curl -fsSL https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.sh | sh
```

```powershell [Windows PowerShell]
irm https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.ps1 | iex
```

:::

Options, set as environment variables:

| Variable              | Effect                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| `VINAX_VERSION=0.1.0` | Install a specific version instead of the latest                                    |
| `VINAX_INSTALL_DIR=…` | Install somewhere other than `~/.vinax/bin` (`%LOCALAPPDATA%\vinax\bin` on Windows) |

If the folder isn't on your `PATH`, the script prints the line to add. On Windows it adds the folder for you.

== npm

```bash
npm install -g @sirimillavinay/vinax
```

== From source

```bash
git clone https://github.com/Vinay1812007/VinaX-CLI.git
cd VinaX-CLI
npm i -g pnpm && pnpm install && pnpm build
node packages/cli/dist/vinax.js --help
```

::::

:::info Binary or npm?
They behave the same, with two differences. The binary keeps keys in `~/.vinax/credentials.json` (readable only by you) instead of the OS keychain. And its `Grep` uses `rg` from your `PATH`, or a built-in search, instead of a bundled ripgrep. `vinax doctor` shows which applies.
:::

## Log in

Setup on first run handles this. To change keys later:

```bash
vinax login groq                  # prompts for the key without echoing it, then checks it
vinax login openrouter
vinax login --gateway https://your-gateway.onrender.com   # use a VinaX gateway instead
vinax logout groq                 # or: vinax logout --gateway
```

Inside a session, `/login` and `/logout` do the same. Keys resolve in this order:

1. Environment variables: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `VINAX_GATEWAY_TOKEN`
2. The OS keychain (macOS Keychain, Windows Credential Manager, libsecret)
3. `~/.vinax/credentials.json`, mode 0600

`vinax config keys` shows each key, masked, and where it comes from.

## Update

```bash
vinax update            # install the latest release
vinax update --check    # only report whether one is available
```

VinaX updates the same way it was installed:

- **Binaries** download the new build, verify its checksum, and replace themselves.
- **npm installs** run `npm install -g`.
- **Source checkouts** tell you to `git pull`.

## Uninstall

::::tabs
== Binary (macOS, Linux)

```bash
rm ~/.vinax/bin/vinax
```

== Binary (Windows)

```powershell
Remove-Item "$env:LOCALAPPDATA\vinax\bin\vinax.exe"
```

== npm

```bash
npm uninstall -g @sirimillavinay/vinax
```

::::

To also remove settings, sessions and stored keys, delete `~/.vinax`. On macOS, also remove the `vinax` entries from Keychain Access.

## Where VinaX keeps things

| Path                          | Contents                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `~/.vinax/settings.json`      | Your settings                                              |
| `.vinax/settings.json`        | Project settings (commit it)                               |
| `.vinax/settings.local.json`  | Your personal settings for one project (git-ignored)       |
| `~/.vinax/projects/<folder>/` | Conversations, checkpoints and prompt history, per project |
| `~/.vinax/state.json`         | Onboarding, trusted folders, approved MCP servers          |
| `~/.vinax/cache/`             | Model lists (refreshed every 24 hours)                     |
| `~/.vinax/logs/`              | Debug logs from `--verbose`, with keys redacted            |

`VINAX_HOME` moves `~/.vinax` somewhere else.
