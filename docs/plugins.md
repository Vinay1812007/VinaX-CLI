# Plugins

<p class="lead">Install a bundle of commands, sub-agents, skills, hooks and MCP servers in one step — and take it out again just as cleanly.</p>

Everything a plugin adds, you could add by hand: a file in `.vinax/commands/`, a folder in `~/.vinax/skills/`, a hook in your settings. A plugin is those pieces packaged together, versioned, and installable from a **marketplace** — a git repository that lists what it offers. This is the same layout Claude Code uses, so a Claude Code plugin works here.

## Using plugins

```
/plugin                                    # marketplaces, installed plugins, what each adds
/plugin marketplace add anthropics/claude-code-plugins
/plugin install toolkit@house              # <plugin>@<marketplace>
/plugin disable toolkit@house              # keep it, stop using it
/plugin enable toolkit@house
/plugin uninstall toolkit@house
/plugin marketplace update                 # git pull every marketplace
/plugin marketplace remove house           # also uninstalls its plugins
```

A marketplace can be a GitHub `owner/repo`, any git URL, or a local folder (used where it is, so a plugin you are writing can be tried without committing anything).

Commands, agents, skills, hooks and MCP servers are read when a session starts, so **run `/clear` or restart VinaX** after installing, enabling or disabling something.

Installing **copies** the plugin into `~/.vinax/plugins/installed/<marketplace>/<name>`. A later `git pull` of the marketplace cannot change what is already running under you; reinstall to take a new version.

## What a plugin may contain

| Path               | What it adds                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `commands/*.md`    | [Slash commands](/commands#custom-commands)                                                  |
| `agents/*.md`      | [Sub-agents](/sub-agents)                                                                    |
| `skills/<name>/`   | [Skills](/skills)                                                                            |
| `hooks/hooks.json` | [Hooks](/hooks), added to yours — a plugin can never switch off a hook you wrote             |
| `.mcp.json`        | [MCP servers](/mcp), started without a per-folder prompt because installing it was your call |

In a plugin's hook commands, `${CLAUDE_PLUGIN_ROOT}` (or `${VINAX_PLUGIN_ROOT}`) is replaced with the folder the plugin was installed into, so a plugin can run its own scripts without knowing where it ended up.

A plugin's command, agent or skill loses a name clash with one of your own: yours wins.

## Writing a plugin

A plugin is a folder with a manifest:

`toolkit/.vinax-plugin/plugin.json` (or `.claude-plugin/plugin.json`):

```json
{
  "name": "toolkit",
  "description": "Our house commands and release skill",
  "version": "1.2.0",
  "author": "Platform team"
}
```

…then whichever of `commands/`, `agents/`, `skills/`, `hooks/` and `.mcp.json` you need.

## Writing a marketplace

A marketplace is a git repository (or any folder) with a catalog at `.vinax-plugin/marketplace.json` or `.claude-plugin/marketplace.json`:

```json
{
  "name": "house",
  "plugins": [
    { "name": "toolkit", "source": "./toolkit", "description": "Our house toolkit" },
    { "name": "deploy", "source": "https://github.com/acme/deploy-plugin.git" }
  ]
}
```

`source` is either a path inside the marketplace or a git URL of its own. Point `/plugin marketplace add` at the folder while you work on it:

```
/plugin marketplace add ./my-marketplace
/plugin install toolkit@house
```

## Security

A plugin can run commands on your machine: its hooks run as you, and its MCP servers start programs. Installing one is the same decision as running someone else's script — read what you are installing, and prefer marketplaces you can see the source of. VinaX does not sandbox plugins.

What VinaX does do: plugin hooks are _added_ to the ones in your settings rather than replacing them, so a plugin cannot quietly disable a check you rely on; and a disabled plugin contributes nothing at all, so `/plugin disable` is a real off switch.
