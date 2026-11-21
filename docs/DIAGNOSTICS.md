# Diagnostics

`console.warn` from plugin code **never reaches OpenCode's log file** — the
only durable, inspectable channel is the plugin KV store (`ctx.storage`),
backed by the OpenCode database. Every subtle code path writes breadcrumbs
here. This is the post-mortem manual.

## Reading the KV

```sh
DB="file:$HOME/.local/share/opencode/opencode.db?mode=ro"
# The plugin KV keys are prefixed with the plugin id, hex-encoded:
sqlite3 "$DB" "SELECT key, value, datetime(time_updated/1000,'unixepoch')
  FROM kv WHERE key LIKE 'plugin:%telegram-bridge%';"
```

All keys below are shown without the `plugin:<hex-id>:` prefix.

## Lifecycle & hub health

| Key | Written when | Notes |
|---|---|---|
| `questionMode` | setup | `form` (native TUI poll + mirror) or `hijack` (Telegram-only fallback). If this says `hijack`, the service registration failed — check `service.json` and the `pid` match. |
| `lastSetup_<dir>` | setup/cleanup | Append log (last 14): `setup begin` → `setup end`, and `cleanup called` on teardown. Missing `setup end` = setup threw. |
| `lastLifecycle_<dir>` | bridge start/stop | Append log: `start begin/end`, `stop begin/end` (per location — the underscore is the location path). `start begin` without `start end` = start hung or threw. |
| `lastHub` | hub register/unregister/watchdog | Append log: `register <loc#session> [uid] → created hub / joined hub (N)`, `unregister … → N left / hub destroyed`, `poll loop silent Ns — restarting`, `hub … emptied while offset loaded — destroyed`. **Two different `[uid]`s both creating hubs is NORMAL** (module state is per location; the lease decides who polls). |
| `pollLease` | every poll cycle | `{"owner":"<module-uid>","at":<ms>}` — must be fresher than 90 s. A stale lease + no fresh one means nobody is polling. |
| `lastPoke` | keep-alive (45 min) | `timestamp \| ok \| created ses_keepalive… + removed`. If this stops advancing, the keep-alive died and the location will be evicted after 60 idle minutes. |
| `offset` | Telegram updates consumed | If frozen while the user reports taps, the poll loop is dead (check `lastHub` / `pollLease`). |

## Form (question poll) flow

| Key | Written when | Notes |
|---|---|---|
| `lastFormEvent` | every `form.*` event | `time \| type \| formID \| session=<id> \| env=<location or none>`. `env` shows the event's location envelope. If you never see `form.created` here, the event stream is broken; if you see it but no cards appear, the mirror gate dropped it (check `tracked`/location). |
| `lastFormPresent` | cards sent | `form=… \| key=… \| chat=… \| session=…` — proves the mirror happened and which wait key/chat it used. |
| `lastFormDelivery` | answer delivery | `replying <formID>` → `delivered <formID>` or `failed <formID>: <error>`. |
| `formTap:<formID>` | live poll | The durable tap record: session, chat, questions, fields, messageIDs, answers, selected, freeText, settled. Empty string = settled/cleared. If a tap says "expired" while the poll is open, compare the record's `chatID`/`settled` with the tap. |
| `formTapIndex` | live polls | CSV of live form IDs (bounded to 20) — drives record-based free-text routing. |

## Taps & permissions

| Key | Written when | Notes |
|---|---|---|
| `lastCallback` | a tap was CLAIMED | `time \| data=<callback_data> \| chat=<id> \| claimed`. The data shows which callback encoding fired (`f:` form, `q:` local question, `p:` permission, `d:` delete). |
| `lastStaleCallback` | a tap nobody claimed | Same plus a dump of every hub handler's state (`debugState`: chat, question keys, form ids, settled flags). This is the "This prompt has expired." post-mortem — if a live poll exists but isn't in the dump, hub membership was lost (reload race). |
| `imageTool` | setup | `registered` / `no-editor-add` / `missing-after-add` / `disabled` — whether `send_telegram_image` got registered. |
| `chat` / `session` | binding | Last active Telegram chat; bound session ID. `session` is validated at startup and cleared if the session was deleted. |

## Standard post-mortems

**"My tap said expired but the poll is open in the TUI."**
1. `lastStaleCallback` → does `data` start with `f:`? Was any handler's state
   showing the form? If the record `formTap:<formID>` exists and matches the
   chat, the tap SHOULD have been claimed — check `lastHub` for a hub destroy
   without re-register, and `pollLease` freshness.

**"The bot stopped responding entirely."**
1. `pollLease` fresh? → yes: the owner is polling (maybe a Telegram-side
   outage); → no: check `lastHub` for watchdog restarts or a destroyed hub
   with no re-register.
2. `lastPoke` advancing? If not, the location may have been evicted.

**"Questions stopped mirroring to Telegram."**
1. `questionMode` — `hijack` means no service connection.
2. `lastFormEvent` — does `form.created` arrive? Is `env` the right location?
3. If the event arrives with the right env but no `lastFormPresent`, the gate
   dropped it (`tracked`/`sessionIsLocal`) or the fields weren't convertible.

**"Which instance owns the poll loop?"**
`pollLease.owner` matches the `[uid]` in `lastHub` register lines (each
location's module logs its own UID).
