<div align="center">

# claudograph

**Drive your Claude Code sessions from Telegram — one bot, many tabs, native rich messages.**

[![runtime: bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Python 3](https://img.shields.io/badge/Python-3.9+-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![grammY](https://img.shields.io/badge/grammY-Telegram%20Bot%20API-26A5E4?logo=telegram&logoColor=white)](https://grammy.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**English** · [Русский](README.ru.md)

</div>

---

`claudograph` is a bridge between [Claude Code](https://docs.claude.com/en/docs/claude-code) and Telegram. It lets **several Claude Code tabs** talk to you through **one** Telegram bot without their messages colliding: each tab gets its own conversation, tappable inline buttons work, replies route back to the right tab, and messages render as **native Telegram Rich Messages** (real headings, tables, collapsible blocks). It can send **screenshots**, stream a **live progress line**, and — with the experimental *channels* feature — **wake an idle tab** when you tap a button from your phone.

It replaces the official `telegram` Claude Code plugin, whose `reply` can't send buttons and whose poller only lets **one** tab receive inbound messages (Telegram allows a single `getUpdates` per bot token).

> **The name:** Telegram is named after the *telegraph*. `claude` + `telegraph` = **claudograph** — an instrument for sending Claude's messages down the wire.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup) — from zero to a working bridge
- [Usage](#usage)
- [Native threads (one topic per tab)](#native-threads-one-topic-per-tab)
- [The hooks — what they inject](#the-hooks--what-they-inject)
- [Verification](#verification)
- [Gotchas](#gotchas)
- [Project structure](#project-structure)
- [License](#license)

---

## Why it exists

The Telegram Bot API allows **exactly one** long-polling `getUpdates` per bot token. Run four Claude Code tabs with the official plugin and only the last one to start receives your replies — the rest go deaf.

`claudograph` fixes this with a **single shared daemon** that owns the one poll. Every tab talks to the daemon over loopback HTTP. Button taps carry the originating tab's handle in their `callback_data`, so a tap always returns to the tab that sent the button. Nothing is exposed to the network — only the daemon's outbound poll reaches `api.telegram.org`; everything server-to-server is on `127.0.0.1`. **No tunnel, no webhook, no inbound port.**

## Features

- 🧵 **One Telegram topic per tab** — each Claude Code tab maps to its own native forum *topic* (thread), so parallel work stays separated. Optional; needs Threaded Mode.
- 🔘 **Real inline buttons** — send tappable choices; the tap returns to the exact tab that asked.
- 🎨 **Native Rich Messages** — write plain GFM markdown; it renders as structured Telegram Rich Messages (headings, bordered tables, task lists, collapsible `<details>`, spoilers, `$LaTeX$`). Falls back to MarkdownV2 → plain automatically.
- 📸 **Screenshots & images** — send a local image (e.g. a page screenshot) straight into the tab's topic.
- 🎤 **Voice notes in** — record instead of typing: voice/audio/video notes are transcribed via any OpenAI-compatible STT endpoint and reach Claude as text. Optional; needs an `STT_API_KEY`.
- ⏳ **Live progress line** — a single message that edits itself as tools run, so you see the work moving, not just the result.
- ✅ **Final-answer mirror** — every turn's answer is pushed to Telegram automatically (summary + collapsible full text), no action needed.
- 📲 **Wake on tap** — with the experimental *channels* flag, tapping a button from your phone can wake an idle terminal session.
- 🔒 **Local-only IPC** — the loopback API is gated by a per-boot secret; the bot token never leaves your machine's config.

## How it works

```
          Telegram (one bot)
                │  getUpdates (outbound long-poll)
                ▼
        ┌───────────────┐        state/threads.json
        │   daemon.ts   │◄──────  state/daemon.secret
        │  one process  │         (owns Bot API + state)
        └───────┬───────┘
                │  http://127.0.0.1:8787  (loopback, secret-gated)
    ┌───────────┼────────────┬───────────────┐
    ▼           ▼            ▼                ▼
session-mcp  session-mcp  stop-notify.py  progress-notify.py
  (tab #1)    (tab #2)     (Stop hook)     (PostToolUse hook)
  Claude       Claude      final answer    live progress line
```

Three moving parts:

1. **`daemon.ts`** — one shared process (auto-started by the first tab). Holds the single Telegram poll, the Bot API, and all state (`threads.json`, the loopback secret). Exposes a loopback HTTP API: `/register`, `/poll`, `/send`, `/edit`, `/react`, `/send-photo`, `/ensure-thread`, `/rename-thread`, `/permission`. Routes button taps (by `callback_data`) and inbound messages (by topic → tab, or swipe-reply).

2. **`session-mcp.ts`** — a stdio [MCP](https://modelcontextprotocol.io) server, spawned by Claude Code **once per tab**. On start it ensures the daemon is up, registers for a short handle, ensures its Telegram topic exists, and long-polls the daemon for this tab's inbound events (surfacing them to Claude as `<channel>` messages). It gives Claude the tools `send`, `edit`, `react`, `send_photo`, `rename_thread`.

3. **Two Python hooks** (wired in Claude Code's `settings.json`) that push to Telegram **directly** (no daemon dependency, so they survive a dead daemon) — see [The hooks](#the-hooks--what-they-inject).

## Requirements

- [**Bun**](https://bun.sh) ≥ 1.0 (runs the TypeScript daemon & MCP server directly)
- **Python** ≥ 3.9 (the two notifier hooks; standard library only)
- **Claude Code** (CLI or the VS Code extension)
- A **Telegram bot token** from [@BotFather](https://t.me/botfather)
- Your **Telegram numeric user id** (ask [@userinfobot](https://t.me/userinfobot))

## Setup

From zero to a working bridge. Paths below assume the repo lives at `~/.claude/claph` — adjust if you cloned elsewhere.

### 1. Create a bot and get its token

In Telegram, message [@BotFather](https://t.me/botfather) → `/newbot` → follow the prompts → copy the token (looks like `123456789:AA...`).

### 2. Clone & install

```bash
git clone https://github.com/PixelShino/claudograph ~/.claude/claph
cd ~/.claude/claph
bun install
```

### 3. Token + allowlist

The bridge reads its token and allowlist from `~/.claude/channels/telegram/` (shared with the official plugin's format, so you can reuse an existing pairing). Create:

`~/.claude/channels/telegram/.env`
```
TELEGRAM_BOT_TOKEN=123456789:AA-your-token-here
```

`~/.claude/channels/telegram/access.json`
```json
{ "allowFrom": ["<your-telegram-user-id>"] }
```

Only user ids in `allowFrom` may talk to the bot — everyone else is ignored. **The bot is yours alone.**

### 4. Register the MCP server (once, user-scope)

```bash
claude mcp add claudograph -s user -- bun "~/.claude/claph/session-mcp.ts"
```

This is picked up by both the CLI and the VS Code extension. To give a tab a fixed name (and its own topic), add an env var at launch — see [Native threads](#native-threads-one-topic-per-tab).

### 5. Wire the hooks (final-answer mirror + progress line)

Add to `~/.claude/settings.json` (create the `hooks` key if missing). These run the two notifiers on the right events:

```json
{
  "hooks": {
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "python \"$HOME/.claude/claudograph/progress-notify.py\"" }] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "python \"$HOME/.claude/claudograph/progress-notify.py\"" },
        { "type": "command", "command": "python \"$HOME/.claude/claudograph/stop-notify.py\"" }
      ] }
    ]
  }
}
```

The hooks are hot-loaded — no restart needed for them to take effect.

> **Windows:** use `pythonw` instead of `python`. `python.exe` is a console app, so
> every hook run flashes a terminal window; `pythonw.exe` is the same interpreter
> without one. Hooks here never write to stdout, so nothing is lost.

### 6. (Optional) Voice notes — speech to text

Claude reads text, not sound. Point the bridge at any OpenAI-compatible
`/audio/transcriptions` endpoint and voice notes, audio files and video notes
arrive as transcripts; without it they arrive as `🎤 (голосовое, расшифровать не
удалось: …)` instead of vanishing. Add to the same `channels/telegram/.env` that
holds the bot token:

```bash
STT_API_KEY=gsk_...                              # required
STT_BASE_URL=https://api.groq.com/openai/v1      # default: https://api.openai.com/v1
STT_MODEL=whisper-large-v3-turbo                 # default: whisper-1
STT_LANGUAGE=ru                                  # default: ru
```

[Groq](https://console.groq.com/keys) has a free tier and is the fastest of the
hosted options; OpenAI's `whisper-1` works with the defaults. Files over 25 MB are
rejected before upload. Note that **not every OpenAI-compatible gateway proxies
audio** — provod.ai, for one, 404s this route.

### 7. Disable the official plugin (avoid a token war)

Two pollers on one token fight (`409 Conflict`). In Claude Code: `/plugin` → Manage → `telegram` → **Disable**. Then restart your tabs.

### 8. (Optional) Wake-on-tap

To let a **tap from your phone wake an idle terminal session**, launch Claude Code with the experimental channels flag:

```bash
claude --dangerously-load-development-channels server:claudograph
```

("dangerous" here only skips the research-preview allowlist.) You'll see a dim startup line confirming `Channels (experimental) messages from server:claudograph inject directly in this session`. **This only works in a terminal launch**, not the VS Code extension panel.

### 9. (Optional) Native threads — Threaded Mode

To get **one Telegram topic per tab**, enable it in [@BotFather](https://t.me/botfather) → your bot → *Bot Settings* → *Threaded Mode* → **On** (and *Disallow users to create new threads* → On, so only the bot creates topics). Fee note: Telegram charges 15% only on Telegram Stars **purchases** made in your bot (ToS §6.2.6) — a bot that sells nothing pays nothing.

---

## Usage

Inside any wired-up tab, Claude has these tools:

| Tool | What it does |
|------|--------------|
| `send` | Send a message. `format` defaults to **rich markdown**; pass `buttons: [{key, label}]` for taps; `format: 'text'` for plain. |
| `edit` | Edit a message this tab sent (for streaming/progress). |
| `react` | React to your message with an emoji. |
| `send_photo` | Send a local image (`path` + optional `caption`) — e.g. a screenshot — into the tab's topic. |
| `send_album` | Send a collage: 2–10 local images as one Telegram album (`paths` + optional `caption`). |
| `rename_thread` | Rename this tab's Telegram topic. |

You just talk to the bot. Text routes to the right tab; tapping a button returns to the tab that asked.

## Native threads (one topic per tab)

Each tab maps to a Telegram topic keyed by a **label** = `CLAPH_LABEL` env var, else the session's own id when Claude Code runs it as a named session (`claude --name`, `--bg`, `claude agents`), else the working-directory name. The daemon creates-or-reuses the topic on start and writes `state/threads.json`; the hooks read it to post into the right topic.

- **Named sessions** → each gets its own topic, named after the session. Claude Code runs many of them out of one directory, so the folder name cannot tell them apart; the session's id can. Renaming a session in the session list renames its topic — the id routes, the name is only what you read.
- **Two tabs in the same repo** → give them distinct labels at launch so they get separate topics:
  ```bash
  CLAPH_LABEL=chat claude          # bash
  $env:CLAPH_LABEL='chat'; claude  # PowerShell
  ```
  Without distinct labels, same-repo tabs **share** one topic (by design). Git worktrees differ by path, so they split automatically. Named sessions never need this — they are already distinct.
- **Closing a tab** → its topic goes 💤 *idle* when the last tab of that label closes; history is kept, nothing is deleted. Reopening the same label reuses the same topic (🟢 active). No duplicate topics.

> Note: an env var must be set **at launch** (both the MCP server and the hooks read it then). The VS Code extension panel can't set per-tab env — launch from a terminal for distinct labels.

## The hooks — what they inject

The bridge's "automatic" behaviour lives in two Python hooks that Claude Code runs on events. They send to the Bot API **directly** (not through the daemon), so they keep working even if the daemon is down, and never trigger a permission prompt.

- **`stop-notify.py`** (`Stop` hook) — after every turn, mirrors Claude's final answer to your topic. It splits the answer into a short **summary** + a collapsible `<details>` with the full text (an explicit `<!-- tg: … -->` marker in the answer sets the summary; otherwise the first paragraph is used). It deduplicates: if Claude already sent an interactive message this turn, it stays quiet instead of double-posting.
- **`progress-notify.py`** (`PostToolUse` + `Stop`) — keeps a **single** live "what I'm doing now" message that edits itself as tools run (throttled; appears only once a turn has some heft), then deletes it on `Stop`. Keyed by session id, so tabs don't collide.

Both compute the tab's label the same way `session-mcp` does, so all three agree on which topic to post into.

## Verification

```bash
bun test                 # unit tests (thread state, dedup logic)
bun test-routing.ts      # queue-isolation test, no real Telegram
```

Python hook logic has `test_*.py` next to the hooks (run with `python test_dedup.py`, etc.).

## Gotchas

- `callback_data ≤ 64 bytes` → handles are short (`h0`, `h1`, …) and button keys must be short too.
- The daemon is single-instance by binding port `8787`; it survives tab restarts. Killing it makes the next tab respawn a fresh one (in-memory session handles reset — tabs re-register).
- `state/daemon.secret` (mode 0600) gates the loopback HTTP from other local processes.
- Deleting a topic in Telegram leaves a stale `threads.json` record; the daemon degrades to the flat chat until the record is cleaned or the topic re-ensured.
- Cyrillic on Windows: the hooks read stdin as UTF-8 bytes (the console codepage mangles it otherwise).
- **One host machine per bot token.** Telegram allows a single `getUpdates` consumer, so a second machine running its own daemon on the same token loses the race: one polls, the other retries forever on `409 Conflict` and receives nothing. The daemon is per-machine, and its port bind only guards against a second daemon on the *same* host. Working from a laptop and a desktop at once needs either a second bot (its own token, its own topics) or one shared daemon the other machine reaches over the network (`CLAPH_PORT` is configurable; `HOST` is loopback by design). Switching to a webhook does not lift this on its own — Telegram delivers to exactly one URL, so multi-machine still needs a relay in front.

## Project structure

```
claudograph/
├── daemon.ts            # shared daemon: poll, Bot API, state, routing
├── session-mcp.ts       # per-tab MCP server (tools + inbound)
├── shared.ts            # config, protocol types, thread-state helpers
├── format.ts            # GFM → MarkdownV2 fallback
├── stop-notify.py       # Stop hook: final-answer mirror
├── progress-notify.py   # PostToolUse+Stop hook: live progress line
├── test-routing.ts      # routing-isolation test
├── *.test.ts / test_*.py# unit tests
└── state/               # runtime (gitignored): secret, threads.json, logs
```

## Contributing

Issues and PRs welcome. Run `bun test` and the `python test_*.py` scripts before submitting.

## License

[MIT](LICENSE) © Dmitry Goldobin
