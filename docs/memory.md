# Memory

<p class="lead">Give VinaX lasting instructions: coding conventions, commands to use, things to avoid.</p>

VinaX reads instruction files at the start of every session and sends them with every request. Keep them short, because they count against the context budget of every call.

## Where memory comes from

| File                                                                                        | Scope                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `~/.vinax/VINAX.md`                                                                         | You, in every project                        |
| `VINAX.md` or `AGENTS.md` in each folder from the repository root down to where you started | The project, shared through git              |
| `VINAX.md` or `AGENTS.md` in a subfolder                                                    | Loaded when VinaX first works in that folder |

`AGENTS.md` is read too, so a repository set up for other coding agents works as is.

## Create and edit memory

- `/init` analyzes the project and writes a starter `VINAX.md`: how to build, test and lint, plus the layout and conventions.
- `/memory` opens a memory file in your `$EDITOR`.
- `#note` at the start of a prompt appends the note to project or personal memory. You choose which.

## Imports

A memory file can pull in another file with `@path/to/file.md` on its own line. Imports nest up to four levels deep.

```markdown
# Project notes

- Use pnpm, never npm.
- Run `pnpm test` before saying a change is done.

@docs/CONVENTIONS.md
```

## Good memory

- Commands to build, test and lint, exactly as they're typed.
- Conventions that aren't obvious from the code.
- Things VinaX should never do (`never edit generated/`).
- Leave out anything the code already says, and long prose.
