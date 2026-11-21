# AGENTS.md

Guidance for AI agents (OpenCode, Claude, Cursor, …) working in this repository.
Read this before changing anything — several constraints here are non-obvious and
were learned by debugging live incidents.

## What this is

An OpenCode plugin that bridges a Telegram bot to the agent: permission cards,
question polls (mirroring OpenCode's native TUI forms), streamed answers,
session/model control, images in both directions, and provider-error alerts.
Runs **inside the OpenCode server process** (`opencode serve --service`) as a
plugin loaded once per **location** (project directory).

- Runtime: OpenCode **v2.2.7** (plugin API `@opencode/plugin@2.0.32` types).
- Language: TypeScript, executed by OpenCode's Bun-compiled host.
- Telegram API: plain `fetch` — deliberately zero Telegram dependencies.
- The only package dependency is `@opencode/client` (provided by the host at
  runtime; declared for types only).

## Non-negotiable rules

1. **Never commit or print secrets.** `secret.txt`, `.env*`, and the bot token
   inside `~/.config/opencode/opencode.jsonc` must never appear in commits,
   diffs, logs, or tool output. The user's Telegram chat ID is also private.
2. **Typecheck gate — identical error set, not zero errors.** Direct `tsc`
   reports **18 pre-existing errors** (missing `@types/node`, token-usage
   `.ts` imports, and three cast/shape errors). Your change is only acceptable
   if the *sorted multiset* of error lines is byte-identical to baseline.
   Verify (invoke tsc directly — `npm run` injects banner lines and breaks the
   hash):
   ```sh
   ./node_modules/.bin/tsc -p tsconfig.json --noEmit 2>&1 \
     | LC_ALL=C sort | sed 's/([0-9]*,[0-9]*)//' | LC_ALL=C sort | md5sum
   # must print 1cdd7381f7d43df03a14e19aa465b357
   ```
   Practical consequences: importing `node:*` needs `// @ts-ignore` on a
   dynamic `import()` (see `src/service.ts`); touch `process` via the
   `globalThis as {...}` cast (see `src/options.ts`, `src/service.ts`); `Buffer`
   is untyped — use `btoa` or similar.
3. **The behavioral harness is the real test.** `npm run test:harness`
   (84 checks, must exit 0). It compiles to `test-dist/` (gitignored) and runs
   `test/harness.mjs`. Add a test for every behavior you change or add.
4. **No new runtime dependencies.** The host provides `@opencode/*` and
   `effect`. Anything else needs a very good reason.
5. **Console output is invisible.** `console.warn`/`log` from plugin code never
   reaches OpenCode's log file. Diagnostics go through `ctx.storage` (the KV
   breadcrumbs — see `docs/DIAGNOSTICS.md`).
6. **`/tmp` is unreliable.** It is wiped regularly (the server restarts clean
   it). Nothing of value lives there anymore; the harness is in `test/`.

## Layout

```
index.ts         # entrypoint shim (OpenCode probes <dir>/index.* for local plugins)
src/
├── index.ts     # Plugin.define entry: options → service client → bot → bridge
├── bridge.ts    # the bulk: hub + lease, event loop, forms, permissions, streaming, commands
├── service.ts   # service.json discovery + OpenCode client (session.form.*)
├── telegram.ts  # minimal Bot API client (fetch + write queue + backoff)
├── media.ts     # image loading, screen capture, pruning
├── events.ts    # event/question types + model-content helpers
└── options.ts   # option parsing with defensive defaults
test/
└── harness.mjs  # behavioral harness (84 checks) — run with npm run test:harness
docs/
├── ARCHITECTURE.md   # how everything fits together — read before touching the hub or forms
└── DIAGNOSTICS.md    # KV breadcrumb reference for post-mortems
```

## Invariants you must not break

These are the load-bearing decisions. Most exist because a live incident proved
their absence fatal:

- **Exactly one `getUpdates` long-poll per bot token.** A second poller gets
  409 "terminated by other getUpdates request" forever. Ownership is a KV
  lease (`pollLease`, TTL 90s) because **module state is per location** — two
  locations do NOT share the `hubs` map (proved with module fingerprints). A
  watchdog restarts a silent poll loop; standbys take over when the lease dies.
- **Form taps are stateless.** Button callbacks encode the form ID
  (`f:<formID>:<idx>:<action>`, ≤64 bytes), and wait state lives in the
  plugin KV (`formTap:<formID>` + `formTapIndex`). Any instance — fresh,
  reloaded, other location — must be able to claim a tap. Do not reintroduce
  volatile-only routing.
- **The TUI poll is the native OpenCode Form.** The built-in `question` tool
  must run untouched (the old execute-hijack killed the TUI poll). Telegram
  *mirrors* the form; both sides settle the same form, first answer wins.
- **A reload must not cancel pending forms** — the TUI poll survives plugin
  reloads; the replacement instance re-attaches via `sweepPendingForms()`.
- **Form mirroring is location-gated twice**: the event's location envelope,
  then a `session.get` location check. Other locations' forms are theirs.
- **Question-tool forms only ever contain `string` and `multiselect` fields**
  with `custom: true` (options keyed by label). Anything else falls back to a
  "answer it in the TUI" notice.
- **Telegram callback data is capped at 64 bytes** — keep encodings compact.
- **`stop()` ordering matters**: question cards are closed *before* the
  `stopped` flag flips (safeEdit refuses afterwards), and the hub is left
  first so no update routes into a dying instance.

## Verification checklist for any change

```sh
npm run typecheck        # error multiset must match the gate hash
npm run test:harness     # 84+ checks must pass
```

Then, if the change affects runtime behavior, hot-reload by touching
`src/index.ts`, wait ~10s, and check the KV breadcrumbs (see
`docs/DIAGNOSTICS.md`) — `questionMode`, `pollLease`, `lastHub`. Remember the
plugin **hot-reloads on every file change** (watcher), so partial edits go live
mid-way; finish a coherent unit before testing live.
