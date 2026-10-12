# Output styles

<p class="lead">How VinaX writes its answers — without changing how it does the work.</p>

An output style replaces the **Answering** section of VinaX's system prompt. Everything else stays exactly as it is: VinaX still reads a file before editing it, runs the project's tests, asks before destructive commands, and never invents command output. A style changes the voice and shape of the reply, not the standards of the work.

Run `/output-style` to pick one, or `/output-style <name>` to switch straight away. The choice is saved to your user settings (`outputStyle`), so it holds for the next session too.

## Built-in styles

| Style         | What you get                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `default`     | Brief and direct. Short answers, code as `path:line`, a few lines of summary when a task is done.                       |
| `explanatory` | The reasoning as well as the result: why this approach, what the surrounding code forced, which trade-off was accepted. |
| `learning`    | VinaX does the groundwork and leaves one telling piece for you, marked `TODO(human)`, then reviews what you write.      |
| `concise`     | The shortest answer that is still complete. No preamble, no closing offers of help.                                     |

`learning` is worth knowing about: VinaX builds everything around one well-chosen gap — the core decision, the tricky condition — writes a `TODO(human)` comment saying what belongs there, and stops. It is slower on purpose.

## Writing your own

`/output-style new <name>` writes a starter file and tells you where it is:

| Folder                    | Scope                             |
| ------------------------- | --------------------------------- |
| `.vinax/output-styles/`   | This project (commit it to share) |
| `~/.vinax/output-styles/` | Just you, in every project        |

A project style wins over a personal one with the same name, and either may take a built-in name to replace it.

`.vinax/output-styles/house.md`:

```markdown
---
name: house
description: Our review voice — findings first, no hedging
---

- Lead with the finding, then the evidence. Never open with a summary of the request.
- Quote code as `path:line`, never as a block longer than ten lines.
- Say "this is wrong because…", not "you might want to consider…".
- End with the one thing you would fix first, and why.
```

The body is the instructions themselves. Write it as rules VinaX follows, not as a description of a style. If it has no `#` heading of its own it becomes the Answering section; give it headings and it replaces the section wholesale.

Styles are read when a session starts, so after editing a file start a new session (or run `/output-style <name>` in a fresh one) to pick the change up. A file VinaX cannot use — an empty body, a name with spaces or punctuation — is reported at startup rather than ignored.

## Styles, memory and skills

These three look similar and are not:

- An **output style** changes how VinaX answers, for every prompt, until you change it.
- [**Memory**](/memory) (`VINAX.md`) carries facts about _this project_: the commands, the conventions, the things that keep catching people out.
- A [**skill**](/skills) carries instructions for _one kind of task_, loaded only when that task comes up.

Put "always answer in German" in a style, "we use pnpm, never npm" in memory, and "how we write release notes" in a skill.
