# Skills

<p class="lead">Instructions for specific kinds of tasks that VinaX loads only when it needs them.</p>

A skill is a folder with a `SKILL.md` file. Its frontmatter names the skill and says when to use it; the body holds the instructions. VinaX tells the model the name and description of every skill up front, and the model loads a skill's full instructions with the **Skill** tool when a task calls for it. Large instructions stay out of the conversation until they're useful. This is the same layout Claude Code uses.

## Where skills live

| Folder                    | Scope                                            |
| ------------------------- | ------------------------------------------------ |
| `.vinax/skills/<name>/`   | This project (commit it to share)                |
| `.claude/skills/<name>/`  | This project, for skills written for Claude Code |
| `~/.vinax/skills/<name>/` | Just you, in every project                       |

A project skill wins over a personal one with the same name.

## Writing a skill

`.vinax/skills/release-notes/SKILL.md`:

```markdown
---
name: release-notes
description: Write release notes from the git log in our house style
---

1. Run `git log --oneline <last-tag>..HEAD` and group the commits into Added, Changed and Fixed.
2. Write one line per user-visible change, in the past tense, without commit hashes.
3. Follow the example in template.md in this folder.
```

- `name` uses letters, digits, dashes and underscores. It defaults to the folder name.
- `description` is required: it is what the model reads when deciding whether to load the skill, so say when to use it.
- Other files in the folder, such as templates, scripts and examples, are listed when the skill loads, so the instructions can refer to them. The model reads them with the Read tool.

## Using skills

- The model loads a skill on its own when a task matches its description. You can also ask directly: "use the release-notes skill".
- Loading a skill needs no approval: the Skill tool only returns the instructions. Anything the skill tells VinaX to do goes through the usual [permissions](/permissions).
- `/skills` lists the installed skills, where each lives, and a template for a new one.
- Skill files with a missing description or an invalid name are reported when the session starts.
