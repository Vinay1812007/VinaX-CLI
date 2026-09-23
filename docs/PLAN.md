# VinaX CLI: Build Plan

Status: **draft for approval**. Nothing outside `docs/` gets built until this plan is approved.

VinaX (`vinax`) is an open-source agentic coding assistant for the terminal. It runs on free-tier Groq and OpenRouter models. Its interaction model follows the public Claude Code docs, used as a behavioral spec. Everything here is an original implementation with VinaX's own name, palette, wording and system prompt.

---

## 0. Research findings that shape the design

These facts were checked on 2026-09-23. Several of them conflict with the build prompt; each conflict is covered in §7.

| Area            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Groq free tier  | 30 RPM per model. The coding-capable models (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`) allow **8K TPM**, 200K TPD and 1K RPD. The Llama chat models are no longer on the free list. Headers: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` plus `retry-after` on 429. `/models` needs a key.                                                                                                        |
| OpenRouter free | 21 `:free` models right now, and 19 of them advertise `tools` support (e.g. `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-31b-it:free`, `cohere/north-mini-code:free`). 20 RPM, and 50 requests/day account-wide (1,000/day after a $10 credit purchase). `/models` is public and includes `supported_parameters` and `context_length`.                                                         |
| Node engines    | The current majors of `ink` (7.x), `openai` (7.x), `execa` (10.x) and `vitest` (5.x) all require **Node ≥ 22**. Node 20 reached end of life in April 2026.                                                                                                                                                                                                                                                                           |
| npm name        | `vinax` is **unclaimed** on npm (404).                                                                                                                                                                                                                                                                                                                                                                                               |
| Local toolchain | Node 24.14 and git 2.54 are installed. `pnpm` and `bun` are **not** installed; I'll enable pnpm via corepack and install bun for M6.                                                                                                                                                                                                                                                                                                 |
| Behavior spec   | Read: interactive mode (shortcuts, `!`/`/`/`@`/`?` prefixes, vim mode, history and reverse search), permissions (allow/ask/deny, `Tool(specifier)`, trailing-`*` prefix rule, gitignore-style path anchors `//`, `~/`, `/`), hooks (event list, stdin JSON, exit-code 0/2/other, JSON output), memory (hierarchical files, nested files loaded on demand, `@import` up to 4 hops), CLI reference (flags, `stream-json`, exit codes). |

---

## 1. Architecture

```
┌──────────────────────── packages/cli (vinax) ─────────────────────────┐
│  bin/vinax.ts ─ commander ─┬─ interactive: Ink <App/>                  │
│                            ├─ headless:   -p runner (text/json/stream) │
│                            └─ subcommands: config|mcp|update|doctor    │
│  ui/  (components, hooks, theme, input editor, markdown renderer)     │
│  tools/  (Read, Write, Edit, MultiEdit, Glob, Grep, LS, Bash,          │
│           WebFetch, TodoWrite, Task, ExitPlanMode) ─ node side effects │
│  commands/ (built-in + custom slash commands)                          │
└───────────────┬───────────────────────────────────────────────────────┘
                │ imports (never the other way)
┌───────────────▼──────────────── packages/core (UI-free) ──────────────┐
│ config/     zod schemas, layered settings loader, secrets store        │
│ providers/  OpenAI-SDK client per provider, model catalog (24h cache), │
│             rate-limit ledger, gateway client                          │
│ router/     fallback chain, backoff+jitter, TPM-aware scheduler        │
│ agent/      AgentLoop (async generator of AgentEvent), system prompt,  │
│             tool-call assembly (native + XML text protocol)            │
│ tools/      Tool interface, registry, zod→JSON-schema, truncation      │
│ permissions/ rule parser+matcher, modes, dangerous-command detector    │
│ context/    token estimator, compaction, memory-file loader            │
│ session/    JSONL store, checkpoints, rewind                           │
│ hooks/      hook runner                                                │
│ mcp/        MCP client manager (stdio + streamable HTTP)               │
│ log/        debug logger with key redaction                            │
└───────────────┬───────────────────────────────────────────────────────┘
                │ HTTPS (BYOK default)            │ opt-in
      Groq / OpenRouter APIs            apps/gateway (Hono on Render)
```

**Module boundaries**

- `core` has no dependency on Ink or React. It exposes `AgentLoop`, which emits a typed `AgentEvent` stream. Both the Ink UI and the headless runner consume that same stream, so print mode and interactive mode can't drift apart.
- Tools are defined in `core` as pure interfaces plus implementations that take an injected `ToolContext` (fs, exec, clock). Tests pass fakes, so the Edit tool and the parser can be tested without touching disk.
- The UI talks to the loop only through `AgentEvent`s out and `UserDecision`s in (approvals, plan approval, interrupts). An approval prompt is a promise the loop awaits.
- `apps/gateway` shares only the zod request types (`core/providers/wire.ts`). It never runs tools.

---

## 2. One agent turn: event and data flow

```
User submits prompt
 │
 ├─► hooks: UserPromptSubmit (exit 2 → block, stderr shown)
 ├─► expand input: @file attachments, [Pasted text #n], custom command templating
 ├─► session.append(user message) ── checkpoint marker for rewind
 │
 └─► LOOP (turn = 1..maxTurns)
      1. context.prepare(): memory files + env info → system prompt;
         estimate tokens; if > 85% of the effective budget → compact() (cheap model)
      2. router.stream(request)
           ├─ pick head of fallback chain whose ledger has quota (RPM/TPM/RPD)
           ├─ waiting for TPM refill < 20s? wait with visible countdown : fall back
           ├─ 429/5xx/timeout → backoff with jitter (max 2 tries) → next link
           │    emits Event{fallback, from, to, reason} → dim one-line notice
           └─ yields deltas: text | native tool_call fragments | usage | headers
      3. assemble tool calls
           ├─ native: merge tool_call deltas by index
           └─ text protocol: incremental XML parser over text deltas
              (<vinax:tool name="Read">{json args}</vinax:tool>), strips tags from display
         malformed native call ×2 on a model → mark model "text-protocol" for the session
      4. for each call: zod-validate args. On failure → synthetic tool_result error
         with the zod issues so the model can self-correct (not executed).
      5. permission check: deny rules → dangerous detector → mode → ask/allow rules
         → hooks: PreToolUse (exit 2 → deny, stderr to model)
         → if "ask": emit Event{permission_request} and await UserDecision
      6. execute: read-only calls in a batch in parallel (Promise.all, bounded);
         mutating calls one at a time; checkpoint files before every mutation
      7. truncate oversized output with a note → hooks: PostToolUse
      8. append assistant msg + tool results to session (JSONL), emit events
      9. no tool calls → break
 │
 └─► hooks: Stop → emit Event{turn_complete, usage}
Esc at any point → AbortController.abort(): stream cancelled, running Bash killed,
partial assistant text kept and marked "[interrupted]"
```

---

## 3. Key interfaces (sketch, in `packages/core`)

```ts
// providers
export interface ProviderId {
  readonly id: 'groq' | 'openrouter' | 'gateway';
}
export interface ModelInfo {
  provider: ProviderId['id'];
  id: string;
  contextWindow: number;
  supportsTools: boolean;
  free: boolean;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolMode: 'native' | 'text';
  maxTokens?: number;
  signal: AbortSignal;
}
export type StreamDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsChunk?: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'rate_limit'; snapshot: RateLimitSnapshot };
export interface Provider {
  readonly id: ProviderId['id'];
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>; // cached 24h on disk
  stream(req: ChatRequest): AsyncIterable<StreamDelta>;
  validateKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
}

// tools
export type PermissionClass = 'read' | 'write' | 'execute' | 'network' | 'mcp';
export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  description: string; // written for the model
  input: I; // zod schema → JSON schema for native mode
  permissionClass: PermissionClass;
  readOnly: boolean; // true → eligible for parallel execution
  permissionTarget(input: z.infer<I>, ctx: ToolContext): PermissionTarget; // path/command/domain
  run(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult<O>>;
  summarize(result: ToolResult<O>): string; // "Read 120 lines"
}
export interface ToolResult<O = unknown> {
  ok: boolean;
  forModel: string;
  display?: ToolDisplay;
  data?: O;
  truncated?: boolean;
}

// permissions
export type RuleEffect = 'allow' | 'ask' | 'deny';
export interface PermissionRule {
  effect: RuleEffect;
  tool: string; // 'Bash' | 'Edit' | 'mcp__srv__*' ...
  specifier?: string; // 'npm run test:*' | 'src/**' | 'domain:github.com'
  source: 'user' | 'project' | 'local' | 'cli' | 'session';
}
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export type PermissionVerdict =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; suggestedRule?: PermissionRule; dangerous?: string };

// sessions
export interface SessionMeta {
  id: string;
  cwd: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
}
export type SessionEntry =
  | {
      type: 'user' | 'assistant' | 'tool_result' | 'system';
      uuid: string;
      parentUuid?: string;
      ts: string;
      message: ChatMessage;
    }
  | { type: 'checkpoint'; uuid: string; files: { path: string; blob: string | null }[] } // null = file did not exist
  | { type: 'summary'; uuid: string; replaces: string[]; text: string };
export interface SessionStore {
  create(cwd: string): Promise<Session>;
  latest(cwd: string): Promise<SessionMeta | undefined>;
  list(cwd: string): Promise<SessionMeta[]>;
  load(id: string): Promise<Session>;
}

// hooks
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';
export interface HookConfig {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number }[];
}
export type HookOutcome =
  { kind: 'continue'; additionalContext?: string } | { kind: 'block'; message: string }; // exit 2 → stderr fed back to the model
```

Checkpoint blobs live in `~/.vinax/projects/<encoded-cwd>/blobs/<sha256>` (content-addressed). Session JSONL rows only reference their hashes.

---

## 4. Specific design decisions

1. **Effective context budget.** For Groq, `effectiveWindow = min(model.contextWindow, observed TPM limit × 0.75)`, because one request has to fit inside one minute's token budget. With an 8K TPM that's about 6K tokens, which is small. The mitigations follow:
   - The system prompt stays lean: about 900 tokens of core text. Tool schemas are sent in a compact form (short descriptions, and long guidance only for Bash and Edit).
   - Compaction triggers at 85% of the _effective_ budget, not the raw window.
   - When the conversation still can't fit, the router prefers a fallback with a larger budget (OpenRouter) for that turn, and shows a dim notice.
2. **Rate-limit ledger.** Each provider and model has a ledger that stores the last headers plus a local sliding window of requests and tokens. The router consults it _before_ sending, so we avoid causing 429s at all. `/status` and the footer read from the same ledger.
3. **Daily counters.** `/usage` data lives in `~/.vinax/usage/<yyyy-mm-dd>.json`: requests and tokens per provider and model. OpenRouter's 50/day cap is shown as, for example, "OpenRouter free: 12/50 today".
4. **Tool-mode detection.** Models whose `/models` entry lacks `tools` use text mode from the start. The same happens if a native call fails twice on a model. The text protocol is documented in the system prompt only when it's active.
5. **Secrets.** Keys go in `@napi-rs/keyring` (service `vinax`). If that fails, they go in `~/.vinax/credentials.json` with mode `0600`. Env vars always win. The logger redacts `sk-…`, `gsk_…`, `sk-or-…` and any `Authorization` header.
6. **Bash.** A persistent shell _cwd_ is tracked by appending `; pwd -P >&3` on fd 3 per call, rather than keeping a long-lived PTY, which is fragile on Windows. Interactive commands (`vim`, `less`, `git rebase -i`, `ssh` without args, ...) are refused with a suggestion. On Windows it uses Git Bash when found, otherwise PowerShell, and the tool description tells the model which shell is active.
7. **Rendering.** The markdown renderer is custom and built on `marked`'s lexer, with `cli-highlight` for code. Streaming renders only complete blocks as markdown and shows the trailing partial block as plain text, so output doesn't flicker. Finished messages go into Ink `<Static>`, which keeps long transcripts cheap to re-render.
8. **Palette.** VinaX's accent is **teal/cyan `#14B8A6`**, with amber `#F59E0B` for warnings. There are three themes: `dark`, `light` and `colorblind` (blue/orange diffs instead of green/red). `NO_COLOR` switches to a monochrome theme that uses `+`/`-` markers only.

---

## 5. Milestones

Every milestone ends with: a green build, green tests (`vitest`), me running VinaX to demonstrate the features, README and CHANGELOG updates, and a summary to you. **Then I stop and wait for "continue".**

| M                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                            | Demo / acceptance                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 Core**          | pnpm monorepo, tsconfig strict, eslint and prettier, changesets. `core`: zod settings with 3-layer precedence, secrets store, Groq and OpenRouter providers, model catalog cache, rate-limit ledger, router with backoff and fallback, streaming. `cli`: commander skeleton, `vinax -p` with stdin plus `text\|json\|stream-json`, exit codes, `--verbose` debug log with redaction, `vinax config`.                             | `echo "hi" \| vinax -p "summarize"` streams from Groq; a forced 429 in the mock server shows the fallback to OpenRouter. Unit tests for the router and backoff. |
| **M2 Terminal UI**   | Ink app, welcome panel with tips, onboarding (5 steps with live key test), folder trust prompt, input box (multiline, paste collapse, history with Up/Down and Ctrl+R), streaming markdown, activity indicator, footer status line, themes and `NO_COLOR`, Ctrl+C/Ctrl+D/Esc, `?` overlay. No tools yet.                                                                                                                         | Chat interactively; ink-testing-library component tests.                                                                                                        |
| **M3 Agent**         | All local tools except Task and WebFetch; native plus XML text protocol; zod error feedback; permission engine with rules, modes (Shift+Tab), dangerous detector, approval prompt with 3 options; diffs; plan mode and ExitPlanMode; auto-accept; checkpoints and the Esc Esc rewind picker; TodoWrite checklist; tree-style tool rendering and Ctrl+O.                                                                          | The DoD scenario runs against a fixture repo. Parser, matcher and Edit unit tests; loop integration test against a mock OpenAI server.                          |
| **M4 Workflow**      | Built-in slash commands; custom commands (frontmatter, `$ARGUMENTS`, `!`, `@`, namespaces); `@` fuzzy files; `!` bash mode; `#` memory note; VINAX.md/AGENTS.md loading (nested on demand, `@import`); `/init`; JSONL sessions, `-c`, `-r` picker, auto titles; auto and manual compaction; `/status`, `/usage`, `/doctor`, `/export`, `/bug`; `/vim`.                                                                           | **v0.1 DoD**: the "fix the failing test" flow on Groq free with transparent OpenRouter fallback and Esc interrupt. Compaction unit tests.                       |
| **M5 Extensibility** | Hooks (5 events, matchers, exit 0/2), MCP client (stdio plus streamable HTTP, `vinax mcp add\|list\|remove`, `/mcp`), sub-agents from `.vinax/agents/*.md` plus the Task tool, WebFetch (turndown plus cheap-model Q&A), `/agents`, `/hooks`.                                                                                                                                                                                    | A sample MCP server and a sample blocking hook demonstrated.                                                                                                    |
| **M6 Ship**          | Hono gateway (`/v1/chat/completions` SSE passthrough plus fallback, `/v1/models`, `/health`, hashed bearer tokens, in-memory limits, size cap, no body logging), `render.yaml`, `vinax login --gateway` with a "Waking VinaX gateway…" state, CI (3 OS), release (changesets → npm, bun binaries → GitHub Release), deploy-gateway via deploy hook, install.sh/.ps1, `vinax update`, docs, SECURITY.md, LICENSE, `.env.example`. | Gateway deployed to your Render account (needs your action; see §8).                                                                                            |

---

## 6. Test strategy

- **Unit (core):** router (chain order, backoff timing with fake timers, header parsing, TPM pre-check), permission matcher (a table of about 60 rule/target cases, including deny precedence, prefix `*`, path anchors, `domain:`, and MCP wildcards), dangerous-command detector, Edit/MultiEdit (uniqueness, `replace_all`, stale-read rejection, atomicity), XML tool parser (chunk boundaries split anywhere, malformed JSON, nested tags in code blocks), compaction (preserves the last N turns, the summary structure, and tool-call/result pairing), and the settings merge.
- **Integration:** a tiny local mock OpenAI-compatible SSE server that replays scripted turns (native and text-protocol variants, plus 429 injection). It runs the full `AgentLoop` against a temp-dir fixture repo.
- **UI:** ink-testing-library for the input box (multiline, paste collapse, history), approval prompt, diff view, status line and todo list.
- **Cross-platform:** path handling through a single `paths.ts` (POSIX-normalized rule matching, native paths for fs). CI covers ubuntu, macos and windows.

---

## 7. Conflicts with free-tier reality, and my proposals

1. **Node 20+ → Node 22+.** Current Ink, openai, execa and vitest need Node ≥ 22, and Node 20 is end-of-life. _Proposal:_ `engines: >=22`. The alternative is pinning older majors on Node 20, which I don't recommend.
2. **Groq's 8K TPM is the binding constraint, not RPM.** A single agent request (system prompt, tools and history) can be 4–7K tokens, so Groq realistically serves **1–2 agent steps per minute**. The DoD flow needs about 8–15 steps. _Proposal:_ the lean prompt, compact schemas and budget-based compaction from §4.1, plus the TPM pre-check. When the wait would exceed 20s, the router falls back to OpenRouter immediately rather than stalling. The DoD will **"work on Groq free with OpenRouter fallback"**, but expect roughly 2–5 minutes per task, and some turns _will_ run on OpenRouter.
3. **OpenRouter's 50 requests/day** covers about 3–5 fallback-heavy tasks per day. _Proposal:_ show the counter prominently. When the daily cap is reached, the chain skips OpenRouter and the notice says so. Recommend the $10 credit purchase (1,000/day) in docs and `/doctor`.
4. **Model IDs change often.** Llama is gone from Groq's free list, for example. _Proposal defaults (config, not code):_ main `groq:openai/gpt-oss-120b`, small/fast `groq:openai/gpt-oss-20b`, fallback chain `groq:qwen/qwen3.8-27b → openrouter:qwen/qwen3.8-27b:free → openrouter:nvidia/nemotron-3-super-120b-a12b:free`. On startup, any configured model missing from `/models` gets a warning and is skipped.
5. **The "cheap model for small tasks" also burns Groq quota.** _Proposal:_ route titles and summaries to `gpt-oss-20b`, which has a separate per-model TPM bucket. Titles are generated lazily, only when the session has at least 2 turns, and are cached.
6. **Standalone binaries via `bun build --compile`:**
   - Native addons (`@napi-rs/keyring`) and `@vscode/ripgrep`'s downloaded binary can't be embedded reliably. _Proposal:_ the binary builds fall back to the 0600 credentials file and to system `rg` or the JS grep.
   - Bun's `windows-arm64` target may be unavailable. If it is, I'll ship x64 there and say so.
7. **Shift+Enter** isn't distinguishable from Enter in many terminals (Terminal.app, older Windows consoles). _Proposal:_ `\`+Enter and Option/Alt+Enter always work. Shift+Enter works where the terminal reports it (kitty keyboard protocol, iTerm2, WezTerm, VS Code, Windows Terminal). `/doctor` reports which applies.
8. **Render free gateway:** it has 750 instance-hours a month, sleeps after 15 minutes idle, and cold-starts in about 1 minute. Shared keys behind a public gateway also **share the same free quotas across every user**. _Proposal:_ the gateway stays opt-in for small groups. The CLI uses a 120s connect timeout for the first request after idle, shows the waking notice, and never retries silently.
9. **Spec scope vs. "parity":** Claude Code has features beyond this spec (background tasks, auto mode classifier, skills, plugins, fullscreen renderer). These are **out of scope for v0.1** and not planned unless you ask for them.
10. **Hooks:** only the 5 events and the `command` type from the spec are implemented. The JSON stdout `decision` form is supported in addition to exit codes, because it costs almost nothing.

---

## 8. Things I need from you

- **API keys to demo milestones.** Neither `GROQ_API_KEY` nor `OPENROUTER_API_KEY` is set in this shell. I can build everything against the mock server, but live demos need keys. Please export them, or I'll enter them through onboarding in M2.
- **npm publish and GitHub Releases (M6):** the npm package name (`vinax` is available), npm access, and push rights to `github.com/Vinay1812007/VinaX-CLI`. The repo lives in `VinaX-CLI/VinaX-CLI` (currently empty, branch `main`).
- **Render (M6):** you create the service from `render.yaml` and add the deploy-hook URL as a GitHub secret. I won't touch your Render account.
- **Commits:** I plan to commit at the end of each milestone on `main` (the repo has no history yet). I won't push unless you tell me to.
