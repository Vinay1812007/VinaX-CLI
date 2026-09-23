# MCP servers

<p class="lead">Give VinaX new tools from Model Context Protocol servers: files, issue trackers, docs, databases.</p>

VinaX is an MCP client for stdio, streamable HTTP and SSE servers. A server's tools appear as `mcp__<server>__<tool>` and go through [permissions](/permissions) like any other tool.

## Add a server

```bash
# a program VinaX starts (put the command after --)
vinax mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/notes

# a remote server, with a header
vinax mcp add docs https://example.com/mcp -H "Authorization: Bearer ${DOCS_TOKEN}"

# an older SSE server, shared with the project
vinax mcp add legacy https://example.com/sse --transport sse --scope project

vinax mcp list            # starts each server and reports its tools
vinax mcp remove files
```

| Option                   | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `--scope user` (default) | Saved in `~/.vinax/mcp.json`, for you in every project |
| `--scope project`        | Saved in `.vinax/mcp.json`; commit it to share         |
| `-e KEY=VALUE`           | Environment variable for a stdio server (repeatable)   |
| `-H "Name: value"`       | HTTP header for a remote server (repeatable)           |
| `--transport http\|sse`  | For URLs: streamable HTTP (default) or SSE             |

## The config file

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/notes"]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

`${VAR}` and `${VAR:-default}` are expanded in commands, arguments, env, URLs and headers, so secrets can stay out of the file.

## Project servers need approval

Project servers run programs that come with the repository, so **they don't start until you approve them**, once per folder. At startup VinaX lists the waiting servers. `/mcp` shows every server's status and lets you allow a project server or retry a failed one.

## Permissions

MCP tools ask before running. Tools the server marks as read-only still ask, because they reach outside your machine. To allow a whole server:

```json
{ "permissions": { "allow": ["mcp__files__*"] } }
```
