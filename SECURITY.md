# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/Vinay1812007/VinaX-CLI/security/advisories/new).
Include steps to reproduce and the VinaX version (`vinax --version`). You should get an answer
within a week. Fixes go into the latest release; older versions are not patched.

## What VinaX does to keep you safe

- **Tools ask first.** Commands, file edits outside `acceptEdits` mode, network access and MCP tools
  need your approval unless an allow rule covers them. Deny rules always win. A built-in check asks
  about destructive commands even in permissive modes.
- **Folders are trusted explicitly.** VinaX asks before working in a folder for the first time.
  Project MCP servers, which run programs that come with a repository, need a separate approval.
- **Keys stay local.** API keys and the gateway token are stored in the OS keychain, or in
  `~/.vinax/credentials.json` with mode 0600. Environment variables override them. Debug logs
  redact keys.
- **The gateway is opt-in and minimal.** It stores only token hashes and never logs request or
  response bodies. It sends no CORS headers, and caps request size and per-token rate. VinaX only
  sends gateway tokens over `https://`, except to `localhost`.
- **Updates are verified.** The install scripts and `vinax update` check every download against
  the release's `SHA256SUMS`. npm packages are published with provenance.

## Secrets in this repository

Never commit keys. Use environment variables or `vinax config set-key`. `.env` files are
git-ignored, and `.env.example` lists the variables. The gateway reads its provider keys only from
its host's environment (Render's dashboard).
