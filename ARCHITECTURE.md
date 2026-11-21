# Architecture

How the bridge works: the actors, the data flows, the invariants, and —
importantly — why each non-obvious decision exists. Every "why" below was
learned from a live incident.

```
                 ┌──────────────────────────────────────────────────────────┐
                 │            OpenCode server process (serve --service)     │
                 │                                                          │
 Telegram ⇄────────│ telegram.ts (Bot API via fetch, write queue, backoff)  │
 (Bot API, 443)  │      ⇅                                                   │
                 │   bridge.ts  ── event loop ──► ctx.event.subscribe       │
                 │      │            (permission.asked, form.*,             │
                 │      │             session.text.*, retry.scheduled, …)  │
                 │      ├── tool.transform ──► send_telegram_image tool     │
                 │      ├── (fallback only) question tool execute hijack    │
                 │      └── service.ts ──► OpenCode HTTP API (127.0.0.1)    │
                 │                            session.form.reply/cancel/…   │
                 │   plugin KV (shared across locations)                    │
                 └──────────────────────────────────────────────────────────┘
```

The plugin runs **inside** the OpenCode server process. It subscribes to
OpenCode's event bus, registers tools, and calls back into OpenCode over HTTP
using the server's own registration file.

## Locations, modules, and the shared KV

OpenCode's plugin supervisor is **location-scoped**: the global config's plugin
is loaded once per booted location (e.g. `~/` and `~/project`). Two facts
follow, and both were proven live:

1. **Module state is per location.** A module-level `Map` in `bridge.ts` is
   instantiated separately in each location — the "one process-wide hub" premise
   was false (verified with a random `MODULE_UID` fingerprint: two locations
   logged different UIDs). Any design that assumes shared in-process state
   across locations is broken from the start.
2. **The plugin KV (`ctx.storage`) IS shared** across locations of the same
   plugin. This is the only shared mutable state, and it is what the poll lease
   and the form-tap records are built on.

Each location's bridge is bound to one session (persisted in KV as `session`),
mirrors output for that session (plus children), and — for question forms — for
every session in its location.

## The hub, the lease, and the watchdog

Telegram allows exactly **one `getUpdates` long-poll per bot token**; a second
poller is answered with 409 "terminated by other getUpdates request" forever,
and both loops retry invisibly (the 409s are swallowed by the client's retry
logic — they never reach the log). Historically this was the "bot keeps
restarting" bug.

Because module state is per location, "one poller per process" needed a
cross-location mechanism:

- **Lease**: KV key `pollLease` = `{ owner: MODULE_UID, at: epoch-ms }`,
  TTL 90 s (one long-poll cycle is 50 s). The owner refreshes it every cycle.
- **Standby**: every other location's loop checks the lease each cycle and, if
  a fresh foreign owner exists, sleeps 10 s and re-checks — it keeps "beating"
  so the watchdog stays quiet, and it still answers what it can (form taps via
  the shared records).
- **Takeover**: if the lease is stale (> 90 s — dead owner), the first standby
  to wake grabs it and starts long-polling. Worst-case tap downtime after a
  crash: ~90 s + one cycle.
- **Watchdog**: each hub runs a loop that restarts `pollHub` if no poll beat
  happened for 180 s while the hub is alive — covering any future bug that
  kills the loop without aborting the hub.

Callback routing: each update is offered to handlers via `wantsCallback`
(now async — it consults the KV for form taps). Form taps (`f:`) are claimed
by ANY location's bridge through the shared record; permission taps (`p:`) are
claimed by the instance that carded them (with `allSessionPermissions: true`,
both locations card everything, so the poller's instance always has the card).

## Question flow: one OpenCode Form, two answer channels

The built-in `question` tool runs **untouched**. It calls `Form.Service.ask`,
which publishes `form.created` and blocks until the form is replied or
cancelled. The form is the single source of truth:

1. `form.created` (kind `question`, session in this location) → the bridge
   converts the form's fields to question cards and sends them to the Telegram
   chat. Buttons encode `f:<formID>:<idx>:<action>` where action is an option
   index, `f` (free text), `c` (clear), `d` (done), or `r` (retry delivery).
2. **Answering from Telegram** — a tap loads the durable record
   (`formTap:<formID>`), mutates it, and when every question is answered calls
   `session.form.reply` over HTTP (via `service.ts`). Typed messages work too:
   `consumeAnswerText` adopts records for the chat.
3. **Answering from the TUI** — the TUI submits the form itself; the
   `form.replied` event reaches the bridge, which updates the Telegram cards
   with the actual winning answer (fetched via `session.form.get` when our own
   reply raced a TUI answer and got `AlreadySettledError`).
4. **Timeout** (`questionTimeoutMs`, default 10 min) →
   `session.form.cancel(formID, { message: "No answer (timed out)." })` — the
   model receives that message as tool feedback and continues, matching
   OpenCode's non-interactive semantics.
5. **Interrupt/dismiss** → `form.cancelled` → cards say "⏹ Dismissed." and the
   record is cleared; later taps answer "expired" honestly.
6. **Delivery failure** (non-AlreadySettled HTTP error) → the answer is NOT
   lost: the card gets a ⚠️ note and a 🔄 Retry button; the record stays until
   a retry succeeds or the timeout cancels the form.

**Reload safety**: `stop()` detaches form mirrors without cancelling the
underlying form (the TUI poll keeps working), notes it on the cards, and the
next instance's `sweepPendingForms()` re-presents still-pending forms from
`session.form.list`. Because taps are stateless, even a card from a dead
instance can be answered by the replacement.

**Fallback**: if the service registration is unavailable at setup (no
`service.json`, foreign pid, probe failure), the plugin falls back to the
pre-lease behavior — replacing the question tool's `execute` with a
Telegram-only flow (in-memory waits, `q:` callbacks). `questionMode` in KV
records which flow is active (`form` vs `hijack`).

### The service connection (`service.ts`)

`~/.local/state/opencode/service.json` — written by the server itself —
contains `{ url, pid, password }`. The plugin:

- reads it (`XDG_STATE_HOME` aware),
- **requires `pid === process.pid`** (the registration must be OUR server —
  a neighbour process's URL would answer against the wrong form cache),
- builds an OpenCode client with `Authorization: Basic btoa("opencode:" + password)`,
- probes `server.info` (3 s timeout) before trusting it.

## Permissions

`permission.asked` → card with Allow once / Allow always / Reject →
`permission.reply`. With `allSessionPermissions: true` every session in the
location is surfaced (and startup replays pending ones). `permission.replied`
closes the card regardless of who replied. The same gate the built-in question
tool runs (`permission.assert` on action `question`) applies before a question
form is created — those prompts surface as permission cards.

## Streaming and output

`session.text.started/delta/ended` drive a single Telegram message that edits
in place (throttled by `streamIntervalMs`), splitting into fresh messages when
the 4096-character cap is hit. Typing indicators on `session.execution.started`.

## Images

- **Inbound**: photo/image documents are downloaded (≤ 20 MB), saved under
  `~/.local/share/opencode/telegram-bridge/media/`, and attached to the session
  as `file://` parts the model can read. Disabled unless `imageReceive`.
- **Outbound**: the `send_telegram_image` tool (target chat resolved inside the
  bridge, never from tool input) reads a file or captures the screen
  (`capture: true`) and uploads via `sendPhoto`.

## Provider alerts

OpenCode retries transient provider failures up to ten times with backoff, and
none of that is visible in the event stream to a casual observer — the bridge
mirrors three events, classified by HTTP status / message wording:

| Event | Classification |
|---|---|
| `session.retry.scheduled` | 🚦 429/rate limit · 💳 402/quota/daily limit · 🔑 401/403/auth · 📡 5xx/network wording · ⚠️ other |
| `session.step.failed` | same table, "Step failed — …" |
| `session.compaction.failed` | "Compaction failed: …" |

The first alert of a category per session goes out immediately; repeats within
3 minutes are suppressed (`providerAlertsAt` map) so a hard outage doesn't spam.
The terminal `session.execution.failed` always notifies. Errors carry
`{ type, message, status?, retryAfterMs? }` — the retry delay is rendered as
"retrying in Ns". Option: `providerAlerts` (default true).

## Keep-alive

OpenCode 2.1+ evicts a location's services after 60 idle minutes (durable
session events with a location envelope are the only thing that touches the
clock — plugin-triggered events do NOT). The bridge creates and removes a
throwaway session every 45 minutes (first poke after 15 s): a guaranteed
location touch with zero side effects. Disable with `keepAlive: false`.

## Reload behavior

The watcher hot-reloads the plugin on any file change — including git
operations inside the repo — and OpenCode reconciles frequently (every model
selection triggers it). A reload cycle per location is: cleanup called →
bridge.stop() (leaves hub, detaches form mirrors, closes cards honestly) →
setup (service probe, bot, hub register or lease-standby, event loop, sweeps).
The system is designed so every intermediate state is safe: cards are either
live, honestly closed, or re-presented.

## Deliberate limitations

- Separate **processes** (two `opencode serve` runs) must use different bot
  tokens — the lease coordinates locations within one process only.
- Telegram inline keyboards cap at 64 bytes of callback data and ~8 buttons
  per row; option labels are truncated and free text is always available.
- Only `string`/`multiselect` question forms are mirrored as polls; other
  form kinds (MCP elicitations, external fields) get a notice.
- The KV diagnostics are per-plugin and last-writer-wins across locations
  except where explicitly keyed by location (`lastLifecycle_*`, `lastSetup_*`).
