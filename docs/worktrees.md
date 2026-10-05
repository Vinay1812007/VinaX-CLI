# Isolated worktrees

<p class="lead">Let VinaX work on a copy of your repository, then review and apply the result yourself.</p>

`vinax --worktree [name]` starts VinaX in a [git worktree](https://git-scm.com/docs/git-worktree) on its own branch, `vinax/<name>`, created from your current `HEAD`. Files VinaX edits there stay out of your checkout until you apply them. Without a name, one like `task-20260105-143000` is chosen.

```bash
vinax --worktree fix-login            # interactive, in the worktree
vinax -p "fix the login bug" -w fix-login --permission-mode acceptEdits

vinax worktree list                   # every VinaX worktree and whether it has changes
vinax worktree diff fix-login --stat  # files with lines added and removed
vinax worktree diff fix-login         # the full diff
vinax worktree apply fix-login        # copy the changes into your checkout
vinax worktree remove fix-login       # delete the worktree and its branch
```

::: warning A worktree is not a sandbox
It keeps **file edits** out of your checkout. Commands VinaX runs there can still read and write anything your user account can: other folders, the network, and the repository's shared `.git` data (branches, stashes, config). Permission rules and modes apply exactly as usual.
:::

## How it works

- **Where.** Worktrees live outside the repository, in `~/.vinax/projects/<repo>/worktrees/<name>`, so they never show up in your own searches, builds or `git status`. If you start VinaX from a subfolder, the session starts in the same subfolder of the worktree.
- **Sessions.** A worktree is a separate project folder for VinaX, with its own sessions. `vinax --worktree <name> -c` continues the latest conversation in it.
- **What counts as a change.** Everything since the worktree was created: commits made in it, uncommitted edits and new files (files your `.gitignore` excludes are left out). Reviewing uses a temporary index, so it changes nothing in either checkout.

## Applying

`vinax worktree apply <name>` writes the worktree's changes into your checkout's files. It does not stage or commit them.

- **Your own uncommitted work is safe.** Edits to other files are left as they are, and the command says how many there were.
- **Conflicts write nothing.** If any part of the change does not apply cleanly (for example, you edited the same lines), nothing is written and the conflict is shown. The patch is saved to `~/.vinax/projects/<repo>/worktrees/<name>.patch`. Commit or stash your changes and apply again, or use `git apply --3way` on that file.

## Removing

`vinax worktree remove <name>` deletes the worktree folder and its `vinax/<name>` branch. It refuses while the worktree holds changes you never applied and lists them. `--force` removes the worktree anyway and discards those changes.
