# Quickstart

<p class="lead">Install VinaX, connect a free model provider, and fix a real bug in about five minutes.</p>

## Before you start

- A terminal on macOS, Linux or Windows.
- A project to work in. Any git repository will do.
- A free API key from [Groq](https://console.groq.com/keys) (fastest) and/or [OpenRouter](https://openrouter.ai/keys). You can use a [gateway token](/gateway) instead of keys.

## Step 1: Install

::::tabs
== macOS, Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.sh | sh
```

== Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.ps1 | iex
```

== npm

```bash
npm install -g @sirimillavinay/vinax
```

::::

Check it worked:

```bash
vinax --version
```

## Step 2: Start VinaX and finish setup

```bash
cd your-project
vinax
```

The first run asks four things:

1. **A colour theme:** dark, light, or colour-blind friendly. A live preview shows each one.
2. **A provider:** Groq, OpenRouter, both (recommended), or a VinaX gateway.
3. **Your API keys.** Each is checked with the provider before it's saved to your OS keychain.
4. **A default model**, from the provider's live model list.

Next, VinaX asks whether you trust the files in this folder. Answer yes for projects you know.

:::tip Prefer environment variables?
`GROQ_API_KEY` and `OPENROUTER_API_KEY` always take precedence over stored keys, and setup picks them up automatically.
:::

## Step 3: Ask about the code

Start with a question. Reading inside the project never needs approval:

```text
what does this project do, and where are its tests?
```

Each tool call appears as one line, with its result underneath:

<pre class="vx-terminal"><span class="accent">▸</span> Glob **/*.test.*
  <span class="dim">└ Found 12 files</span>
<span class="accent">▸</span> Read package.json
  <span class="dim">└ Read 31 lines</span></pre>

## Step 4: Fix something

```text
the tests fail — find out why and fix it
```

VinaX asks before running a command or changing a file. Each prompt offers three answers:

- **Yes**
- **Yes, and don't ask again**, for this command pattern or for edits in this session
- **No, and tell VinaX what to do differently**

Edits are shown as diffs before you approve them. After the fix, VinaX re-runs the tests and summarizes what it changed.

<pre class="vx-terminal"><span class="accent">▸</span> Bash npm test
  <span class="dim">└ Exit 1 · 31 lines · 0.4s</span>
<span class="accent">▸</span> Edit src/math.js
  <span class="dim">└ Changed +1 −1 lines</span>
      4 -   return sum / (values.length - 1);
      4 +   return sum / values.length;
<span class="accent">▸</span> Bash npm test
  <span class="dim">└ Exit 0 · 9 lines · 0.3s</span></pre>

:::info Changed your mind?
Press **Esc** at any time to stop. Press **Esc Esc** on an empty prompt to [rewind](/permissions#rewind) to an earlier prompt and restore the files VinaX changed.
:::

## Step 5: Keep going

| Try                | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `/help`            | Every command and shortcut                        |
| Shift+Tab          | Cycle default → auto-accept edits → plan mode     |
| `@src/app.ts`      | Attach a file to your prompt                      |
| `!git status`      | Run a shell command yourself and share its output |
| `#always use pnpm` | Save a note to project memory                     |
| `/init`            | Write a starter `VINAX.md` for this project       |

## Next steps

- [Interactive mode](/interactive-mode): every shortcut, plus multi-line input and history.
- [Permissions](/permissions): allow common commands so VinaX asks less.
- [Models and rate limits](/models): how VinaX stays within free tiers.
