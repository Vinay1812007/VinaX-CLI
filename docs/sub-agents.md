# Sub-agents

<p class="lead">Hand a self-contained job to a separate agent that works with its own context and reports back.</p>

The `Task` tool runs a sub-agent: a fresh conversation with the same permissions, which works on one job and returns a short report. Long searches and reviews stay out of the main conversation, so it stays small.

<pre class="vx-terminal"><span class="accent">▸</span> Task reviewer: review app.js
  <span class="dim">└ Done · 1 tool call</span></pre>

## Built-in agent

`general-purpose` can use every tool, and is used when VinaX doesn't pick a specific agent.

## Your own agents

Add a Markdown file to `.vinax/agents/` for the project, or `~/.vinax/agents/` for yourself:

```markdown
---
name: reviewer
description: Reviews code for bugs and missing tests
tools: Read, Grep, Glob
model: groq:openai/gpt-oss-20b
---

You are a careful code reviewer. Report problems with file paths and line numbers.
```

| Frontmatter   | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `name`        | How VinaX refers to it: lowercase letters, digits and dashes (defaults to the file name) |
| `description` | **Required.** When to use this agent; VinaX reads it to decide                           |
| `tools`       | Optional. The tools it may use; wildcards like `mcp__github__*` work                     |
| `model`       | Optional. Its model, e.g. a smaller one for cheap jobs                                   |

The body is the agent's instructions. `/agents` lists every agent and where it's defined.

## Limits

- Sub-agents can't start sub-agents of their own.
- Each Task gets at most 30 model calls.
- Approvals still come to you, because sub-agents share your permissions and rules.
