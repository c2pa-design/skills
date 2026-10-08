# c2pa.design skills

Agent skills for C2PA Content Credentials, for Claude Code, Codex, Cursor, Gemini CLI, GitHub
Copilot and any agent that reads [Agent Skills](https://agentskills.io).

| Skill | What it does |
|---|---|
| [`c2pa-check`](skills/c2pa-check/SKILL.md) | Checks files and URLs for Content Credentials, keeps `.c2pa/assets.lock.json` for every asset in the repo, and flags any asset that lost its credential since the last run. |
| [`c2pa-integrate`](skills/c2pa-integrate/SKILL.md) | Connects a project to the c2pa.design API: client, keys in env, retries, signed webhooks, domain crawling, monitors and a CI gate. |

## Install

```bash
npx skills add c2pa-design/skills
npx skills add c2pa-design/skills -a claude-code    # one agent: codex, cursor, gemini-cli, github-copilot
```

Claude Code plugin (skills, MCP server, and a hook that reminds the agent to run
`c2pa-check carry` after `sharp`, `cwebp`, `avifenc`, `ffmpeg`, `magick`, `convert`, `squoosh`,
`gifsicle` or `vips` writes media from an original that carries a Content Credential):

```
/plugin marketplace add c2pa-design/skills
/plugin install c2pa-check@c2pa-design
```

Manual: copy `skills/c2pa-check` into `~/.claude/skills/` (or your agent's skills folder).

## Requirements

The skill drives the [`c2pa-check`](https://github.com/c2pa-design/c2pa-check) CLI, which runs
offline and needs no account:

```bash
brew install c2pa-design/tap/c2pa-check      # or: cargo install c2pa-check, or npx -y c2pa-check
```

`C2PA_API_KEY` from [app.c2pa.design](https://app.c2pa.design) is optional; it adds URL checks,
production monitors and the dashboard. Only hashes and check results leave the machine, never
the files.

Docs: [c2pa.design/docs/agents](https://c2pa.design/docs/agents).

## Licence

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE).
