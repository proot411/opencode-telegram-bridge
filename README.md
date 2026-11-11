# opencode-telegram-bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenCode plugin](https://img.shields.io/badge/OpenCode-plugin-brightgreen.svg)](https://opencode.ai)
[![Zero dependencies](https://img.shields.io/badge/dependencies-none-2ea44f.svg)](#development)

Drive your [OpenCode](https://opencode.ai) agent from Telegram. Approve permissions,
answer questions, swap models, exchange photos, and watch answers stream into your
chat — from your phone, while you're away from the keyboard.

- **Permission cards** — pending permissions arrive as a card with inline buttons: *Allow once* / *Allow always* / *Reject*.
- **Questions as buttons** — the built-in `question` tool is replaced so the agent asks you directly in Telegram: tappable single/multi-select options or free text, no form UI.
- **Live streaming** — the agent's answer streams into one Telegram message that edits itself in place.
- **Full session control** — create, list, switch, rename, compact, and delete sessions; switch models and agents without touching the terminal.
- **Images in both directions** — send a photo and the agent sees it; ask the agent for a screenshot and it pushes one back through the `send_telegram_image` tool.
- **Keep-alive** — survives OpenCode's hardcoded 60-minute idle eviction so the bridge never silently dies on you.
- **Token usage** — `/tokens` reports honest per-window totals via the companion `token-usage` plugin.
- **Zero runtime dependencies** — the Telegram Bot API is called with plain `fetch`. Nothing to `npm install` to run it.

---

## 1. Create a bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram: `/newbot`.
2. Follow the prompts and pick a name/username.
3. BotFather replies with a **token** like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
   **Anyone with this token controls your bot — never commit it.**

## 2. Register the plugin

Add the plugin to your `opencode.json(c)` (project-level or `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-telegram-bridge",
      "options": {
        "token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "chatIDs": []
      }
    }
  ]
}
```

Instead of `token` in the config you can export `TELEGRAM_BOT_TOKEN` (or
`OPENCODE_TELEGRAM_TOKEN`) in the environment where OpenCode runs — the config
value wins when both are set.

Restart the OpenCode service (or reload config) afterwards.

> **Note:** the plugin must be registered in a config file. Files under
> `.opencode/plugins/` are auto-discovered, but a plugin loaded from a path like
> this one is not.

## 3. Allow your chat

The bridge only lets explicitly allowed chats drive the agent. With `chatIDs: []`:

1. Send any message to your bot in Telegram.
2. The bot replies with **your chat ID** (this is what `revealChatID` does).
3. Put it in the config (`chatIDs` accepts numbers or strings) and restart:

```jsonc
"options": {
  "token": "...",
  "chatIDs": ["123456789"]
}
```

Send `/help` to the bot — you should see the bridge is connected.

> Prefer never typing the ID? Set `"allowAllChats": true` — **anyone** who can reach
> the bot can then drive your agent. Only do this for a private, token-protected bot.

## Commands

| Command | What it does |
| --- | --- |
| `/help` | Show the help card |
| `/new` | Start a fresh session and bind the chat to it |
| `/session` | Show the bound session (id, title, agent, model) |
| `/sessions` | List every session on this machine |
| `/switch <n>` | Rebind the bridge to the *n*-th session from `/sessions` |
| `/status` | Session info + pending permission requests |
| `/tokens` | Token usage totals per window *(requires the token-usage plugin)* |
| `/allow [n]` | Approve the *n*-th pending permission (default 1) |
| `/deny [n]` | Reject the *n*-th pending permission (default 1) |
| `/cancel` | Interrupt the agent |
| `/models [text]` | List models, optionally filtered by a search string |
| `/model <n\|provider/id>` | Switch the bound session's model |
| `/agents` | List available agents |
| `/agent <n\|name>` | Switch the bound session's agent |
| `/rename <title>` | Rename the bound session |
| `/compact` | Compact the bound session |
| `/delete <n>` | Delete the *n*-th session from `/sessions` (asks to confirm) |

Any other message is delivered to the session. If a question is open, your next
message answers it instead of prompting the agent.

## Images

**Receiving** (`imageReceive`, default on): send a photo — with or without a
caption — and the agent receives it as a vision-capable message. Screenshot your
whiteboard, photograph your monitor, paste a diagram; the agent sees what you see.

**Sending** (`imageSend`, default on): the agent gets a `send_telegram_image` tool
it can call to push a picture into your chat:

```jsonc
// tool input
{ "path": "/path/to/plot.png", "caption": "the chart you asked for" }
{ "capture": true, "caption": "my screen, right now" }   // live screenshot
```

- `path` sends an existing file; `capture: true` grabs the screen instead
  (one of the two is required).
- The destination is the primary (bound) chat — the bridge is single-account by
  design, so images can't leak into the wrong conversation.

## Token usage

`/tokens` reports usage windows (1 h / 24 h / 7 d / 365 d / lifetime) with
input/output/reasoning/cache splits and estimated cost:

```text
📊 Token usage

24 hours — 25.5M (18.2M in / 7.3M out) · $0.002
lifetime — 410.2M (281.4M in / 128.8M out) · $0.006

lifetime: 3,898 model calls · 42.1M in the last hour
reasoning 9.8M · cache 180.2M read / 44.6M write
tracked since 2026-09-23
hourly detail kept 30 days · lifetime totals never expire
```

It needs the companion **token-usage** plugin at
`~/.config/opencode/plugins/token-usage`. Without it, the command degrades to a
single explanatory message — every other bridge feature keeps working.

## Options

All options live under the plugin's `options` object in `opencode.json(c)`.

| Option | Default | Description |
| --- | --- | --- |
| `token` | `$TELEGRAM_BOT_TOKEN` | Bot token from @BotFather (env fallback: `OPENCODE_TELEGRAM_TOKEN`) |
| `chatIDs` | `[]` | Allowed chat IDs (numbers or strings). Send the bot a message to discover yours |
| `allowAllChats` | `false` | ⚠️ Accept commands from **any** chat |
| `revealChatID` | `true` | Reply to unknown chats with their own ID (helps discovery) |
| `announce` | `true` | Send a "connected" notice on startup |
| `sessionID` | — | Bind to an existing session instead of creating one on first message |
| `delivery` | `"steer"` | How inbound messages join a busy session: `"steer"` or `"queue"` |
| `stream` | `true` | Live-edit one message while the agent streams its answer |
| `streamIntervalMs` | `1500` | Minimum gap between streaming edits (250–30000) |
| `typing` | `true` | Show a "typing…" indicator while the agent works |
| `toolNotifications` | `false` | Notify on every tool call (🔧 / ✅ / ❌) |
| `forwardAllSessions` | `false` | Mirror **every** session in this location, not just the bridged one |
| `allSessionPermissions` | `false` | Surface and manage permission requests from **every** session in this location; `/status`, `/allow`, `/deny` span them all |
| `questionTimeoutMs` | `600000` | How long an agent question waits before resolving as "Unanswered" (5000–3600000) |
| `pollTimeoutSec` | `50` | Telegram long-poll window (10–50 s) |
| `keepAlive` | `true` | Periodically poke OpenCode so its 60-minute idle sweep can't evict the location (see below) |
| `imageSend` | `true` | Expose the `send_telegram_image` tool to the agent |
| `imageReceive` | `true` | Accept photos sent from Telegram and hand them to the agent |
| `apiBase` | `https://api.telegram.org` | Override for a local Bot API server / proxy |

Options are validated defensively: a typo degrades to the default instead of
breaking plugin activation (a plugin that throws during setup is disabled).

## Keep-alive

OpenCode evicts idle locations after 60 minutes of no activity — and an evicted
location takes the bridge with it. Plugin event subscriptions are enough to *hear*
the world, but not enough to *count as activity*, so a quiet bridge would silently
die exactly one hour after the last message.

With `keepAlive: true` (default) the plugin periodically creates and immediately
removes a throwaway session — a net-zero operation that costs no model calls and
no bindings. `session.created` is published with an explicit location, which is
the one poke the idle sweeper reliably counts. The bridge stays resident for as
long as OpenCode runs.

Disable it only if something else in that location already keeps it busy.

## How it works

- **Permissions** — `permission.asked` events are rendered as an inline-keyboard
  card; a tap calls `permission.reply({ decision })`. Pending requests that existed
  before the plugin started are replayed on startup. Replies from other clients
  close the card too (`permission.replied`).
- **Questions** — the built-in `question` tool (`ctx.tool.transform` → `editor.update`)
  is replaced with an implementation that keeps the same permission gate
  (`permission.assert` on action `question`) and then asks in Telegram, returning
  the same `output`/`content`/`metadata` shape the model expects. `form.created`
  remains as a safety net: if the override ever misses, you get a heads-up
  notification instead of silence.
- **Streaming** — `session.text.started/delta/ended` events drive one Telegram
  message that is edited in place (throttled by `streamIntervalMs`), falling back
  to a fresh message per chunk when streaming is off or the message grew too large.
- **Media** — inbound photos are fetched from Telegram and passed to the agent;
  outbound images are read from disk or captured live and uploaded via
  `sendPhoto`. One write queue serializes all bot API calls so edits, uploads, and
  replies can't race each other.
- **Storage** — chat ID, bound session, and the Telegram update offset persist in
  the plugin's own `ctx.storage`, so restarts don't replay old messages.

```text
Telegram  ⇄  telegram.ts (Bot API client)  ⇄  bridge.ts (event loop & commands)
                                          ↕
                          OpenCode plugin context (events, tools, storage)
```

## Security

- **Never commit your bot token.** Keep it in `secret.txt`, an environment
  variable, or the config of a private dotfiles repo — `secret.txt` is listed in
  `.gitignore` for exactly this reason.
- **The chat allowlist is the front door.** With `allowAllChats: false` (default),
  every unknown chat is told to go away and shown its own ID instead of being heard.
- **One bot, one location.** See limitations below — a token shared across running
  locations would let update streams collide.

## Limitations & notes

- **One location per token.** If several OpenCode projects run simultaneously, each
  loads its own bridge and they would compete for the same bot's update stream.
  Use one bot per active location (or leave the bridge enabled in only one project).
- Telegram messages cap at 4096 characters; longer output is split automatically.
- Question select lists are capped by Telegram's inline-keyboard practical limits —
  very long option lists get truncated labels, and "Type your own answer" is always
  available as a fallback.
- `capture: true` screenshots whatever the machine's display shows — mind the
  screen contents when the agent is capturing on your behalf.
- `/tokens` needs the token-usage companion plugin; without it, only that command
  is affected.

## Development

```text
index.ts         # entrypoint shim (OpenCode probes <dir>/index.* for local plugins)
src/
├── index.ts     # Plugin.define entry: options → bot → bridge → question-tool override
├── bridge.ts    # event loop, permission cards, question flow, streaming, commands
├── telegram.ts  # minimal Bot API client (fetch + write queue + backoff)
├── media.ts     # image loading and screen capture
├── events.ts    # event/question types and model-content helpers
└── options.ts   # option parsing with defensive defaults
```

Typecheck (requires Node/npm, not bundled with OpenCode):

```sh
npm install
npm run typecheck
```

The package has no runtime dependencies — `@opencode/plugin` and `effect` are
always provided by the OpenCode host at runtime, and the Telegram API is called
with plain `fetch`.

## License

[MIT](LICENSE)
