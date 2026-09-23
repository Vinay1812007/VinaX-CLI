---
title: Overview
---

# Overview

<p class="lead">VinaX is an open-source coding agent for your terminal. It reads your codebase, edits files, runs commands and checks its own work, and it runs on free-tier models from Groq and OpenRouter.</p>

VinaX works like a teammate in your shell. You describe a task in plain language. VinaX explores the code, proposes changes as diffs, runs your tests, and asks before doing anything risky. The agent loop and every tool run on your machine; only model requests leave it.

## Get started

You need a free API key from [Groq](https://console.groq.com/keys) or [OpenRouter](https://openrouter.ai/keys), or both. You can also use a token for someone's [VinaX gateway](/gateway). Choose how to install:

::::tabs
== Install script (recommended)
The standalone binary needs no Node.js. It is available for macOS, Linux and Windows on x64 and arm64.

::: code-group

```bash [macOS, Linux]
curl -fsSL https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.sh | sh
```

```powershell [Windows PowerShell]
irm https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.ps1 | iex
```

:::

The script picks the right build for your machine, checks it against the release's `SHA256SUMS`, and installs it to `~/.vinax/bin`. On Windows the folder is `%LOCALAPPDATA%\vinax\bin`.

:::info
Standalone installs update themselves with `vinax update`, which verifies every download before replacing the binary.
:::

== npm
Needs Node.js 22 or newer.

```bash
npm install -g @sirimillavinay/vinax
```

Or try it once without installing:

```bash
npx @sirimillavinay/vinax
```

:::info
npm installs update with `vinax update`, which runs `npm install -g @sirimillavinay/vinax@latest` for you.
:::

== Download a binary
Every [GitHub Release](https://github.com/Vinay1812007/VinaX-CLI/releases/latest) has a binary for each platform. The x64 builds also run on older CPUs.

| Platform                     | File                                               |
| ---------------------------- | -------------------------------------------------- |
| macOS (Apple silicon, Intel) | `vinax-darwin-arm64`, `vinax-darwin-x64`           |
| Linux (glibc)                | `vinax-linux-x64`, `vinax-linux-arm64`             |
| Linux (musl, e.g. Alpine)    | `vinax-linux-x64-musl`, `vinax-linux-arm64-musl`   |
| Windows                      | `vinax-windows-x64.exe`, `vinax-windows-arm64.exe` |

Check the download against `SHA256SUMS` from the same release, make it executable, and put it on your `PATH` as `vinax`.

== From source

```bash
git clone https://github.com/Vinay1812007/VinaX-CLI.git
cd VinaX-CLI
npm i -g pnpm && pnpm install && pnpm build
node packages/cli/dist/vinax.js
```

::::

Then start VinaX in any project:

```bash
cd your-project
vinax
```

The first run walks you through a short setup: a colour theme, your provider, your API keys (each is checked live before it's saved) and a default model. That's all. [Continue with the Quickstart →](/quickstart)

:::tip
[Install and set up](/setup) covers updating, uninstalling and where VinaX keeps its files. If something goes wrong, run `vinax doctor` or see [Troubleshooting](/troubleshooting).
:::

## What you can do

Here are some of the ways people use VinaX:

<div class="vx-accordion-group">

<details class="vx-accordion">
<summary><span class="vx-icon">✓</span>Fix failing tests and bugs</summary>
<div class="vx-body">

Paste an error, or just say what's broken. VinaX reads the relevant files, runs the test command once you approve it, and proposes a fix as a diff. Then it re-runs the tests to confirm.

```bash
vinax "the checkout tests fail since yesterday — find out why and fix it"
```

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">✎</span>Build features across files</summary>
<div class="vx-body">

Describe the change. VinaX plans it, keeps a live checklist of the steps, and edits every file involved. Switch to [plan mode](/permissions#modes) with Shift+Tab to review the plan before anything changes.

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">⌕</span>Understand an unfamiliar codebase</summary>
<div class="vx-body">

Ask how something works. VinaX searches with `Grep` and `Glob`, reads the files that matter, and explains, with file paths and line numbers to follow up on. Attach specific files with `@path`.

```bash
vinax "how does a request get from the router to the database?"
```

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">⇄</span>Script it and pipe to it</summary>
<div class="vx-body">

[Print mode](/print-mode) answers once and exits, so VinaX fits in pipes, scripts and CI:

```bash
git diff | vinax -p "write a commit message for this diff"
vinax -p "summarize src/" --output-format json
```

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">⚙</span>Customize it for your project</summary>
<div class="vx-body">

- **Memory:** put conventions in a [`VINAX.md`](/memory) file, which VinaX reads every session.
- **Custom commands:** add them as Markdown in `.vinax/commands/` ([Commands](/commands#custom-commands)).
- **Hooks:** run [hooks](/hooks), shell commands that fire before or after tools, for example a formatter after every edit.

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">⚡</span>Connect tools with MCP and delegate to sub-agents</summary>
<div class="vx-body">

[MCP servers](/mcp) give VinaX new tools, such as your issue tracker, docs or database. [Sub-agents](/sub-agents) take on self-contained jobs, like a code review or a wide search, with their own context, and report back.

</div>
</details>

<details class="vx-accordion">
<summary><span class="vx-icon">∞</span>Keep working on free tiers</summary>
<div class="vx-body">

VinaX tracks each model's rate limits. When one is exhausted it waits briefly or moves down your [fallback chain](/models), and shows a one-line notice. Long conversations are [compacted](/sessions#compaction) automatically so every request stays small.

</div>
</details>

</div>

## Where to look

| I want to…                               | Go to                                 |
| ---------------------------------------- | ------------------------------------- |
| Get through my first task step by step   | [Quickstart](/quickstart)             |
| Control what VinaX may do without asking | [Permissions](/permissions)           |
| Pick models and understand rate limits   | [Models and rate limits](/models)     |
| Run VinaX in scripts or CI               | [Print mode and scripts](/print-mode) |
| Share keys with a team or class          | [Gateway](/gateway)                   |
| Add tools from other services            | [MCP servers](/mcp)                   |
| See every command and flag               | [CLI reference](/cli-reference)       |

## Next steps

<div class="vx-cards">
  <a class="vx-card" href="/VinaX-CLI/quickstart"><div class="vx-card-title">Quickstart</div><div class="vx-card-text">Your first real task, from exploring a repo to a tested fix.</div></a>
  <a class="vx-card" href="/VinaX-CLI/interactive-mode"><div class="vx-card-title">Interactive mode</div><div class="vx-card-text">Shortcuts, multi-line input, history and turn details.</div></a>
  <a class="vx-card" href="/VinaX-CLI/memory"><div class="vx-card-title">Memory</div><div class="vx-card-text">Give VinaX lasting instructions with VINAX.md files.</div></a>
  <a class="vx-card" href="/VinaX-CLI/settings"><div class="vx-card-title">Settings</div><div class="vx-card-text">Models, permissions, themes and more, per user or per project.</div></a>
  <a class="vx-card" href="/VinaX-CLI/troubleshooting"><div class="vx-card-title">Troubleshooting</div><div class="vx-card-text">Rate limits, keys, terminals and Windows.</div></a>
  <a class="vx-card" href="https://github.com/Vinay1812007/VinaX-CLI"><div class="vx-card-title">Source on GitHub</div><div class="vx-card-text">Issues, releases and the MIT-licensed code.</div></a>
</div>
