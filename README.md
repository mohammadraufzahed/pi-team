# pi-team

Teammate messaging for multi-agent
[pi](https://github.com/earendil-works/pi-coding-agent) setups — real
tool calls instead of text markers, so agent-to-agent comms work in
every run path (chat, pipelines, scheduled jobs).

## Tools

| Tool | Purpose |
|---|---|
| `team_roster` | Who's on the team — names, roles, capabilities |
| `team_ask` | Ask a teammate; blocks until their reply arrives |
| `team_handoff` | Hand the whole request to a teammate |
| `team_say` | Post a chat message immediately, mid-run |

## Transport

A file mailbox under `$PI_TEAM_DIR`
(default `~/.local/state/telegram-agent/team`):

```
requests/<id>.json  {id, from, to, kind, text, chat, thread, at}
replies/<id>.json   {id, text, at}
```

The host process (e.g. a Telegram bot) watches `requests/`, runs the
target agent, posts via its identity, and writes the reply — the
calling agent's `team_ask` returns it inline.

## Identity (env, injected by the host)

| Var | Meaning |
|---|---|
| `PI_TEAM_FROM` | calling agent's name |
| `PI_TEAM_CHAT` / `PI_TEAM_THREAD` | chat context for posts |
| `PI_TEAM_DIR` | mailbox dir |
| `SOULS_DIR` | soul files for `team_roster` |

## Install

```bash
pi install git:github.com/mohammadraufzahed/pi-team
```

## License

MIT
