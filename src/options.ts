/**
 * Plugin option handling.
 *
 * Every option is read from the `options` object in `opencode.json(c)`:
 *
 * ```jsonc
 * {
 *   "plugins": [
 *     { "package": "/absolute/path/opencode-telegram-bridge", "options": { "chatIDs": [123456789] } }
 *   ]
 * }
 * ```
 *
 * Values are validated defensively so a typo degrades to a default instead of
 * breaking plugin activation (a plugin that throws during setup is disabled).
 */
export interface BridgeOptions {
  /** Bot token from @BotFather. Falls back to `TELEGRAM_BOT_TOKEN`. */
  readonly token: string
  /** Telegram API origin, override for a local Bot API server or a proxy. */
  readonly apiBase: string
  /** Normalized (stringified) chat IDs allowed to drive the agent. Empty means nobody. */
  readonly chatIDs: ReadonlySet<string>
  /** Dangerous: let every chat that can reach the bot drive the agent. */
  readonly allowAllChats: boolean
  /** Reply to unauthorized chats with their own chat ID so it can be allow-listed. */
  readonly revealChatID: boolean
  /** Send a "connected" notice when the bridge starts. */
  readonly announce: boolean
  /** Bind to an existing session instead of creating one on first message. */
  readonly sessionID?: string
  /** How inbound messages join a session that is already working. */
  readonly delivery: "steer" | "queue"
  /** Live-edit a Telegram message while the agent streams its answer. */
  readonly stream: boolean
  /** Minimum gap between edits of the same streaming message. */
  readonly streamIntervalMs: number
  /** Notify about tool calls and their outcomes. */
  readonly toolNotifications: boolean
  /** Show a transient "typing…" indicator while the agent works. */
  readonly typing: boolean
  /** Forward output of every session in this location, not just the bridged one. */
  readonly forwardAllSessions: boolean
  /**
   * Surface and manage permission requests from every session in this location,
   * not just the bridged one: startup replay, live `permission.asked` cards, and
   * the `/status`, `/allow`, and `/deny` commands all span every session.
   */
  readonly allSessionPermissions: boolean
  /** How long an agent question waits for a Telegram answer. */
  readonly questionTimeoutMs: number
  /** Telegram long-poll window in seconds. */
  readonly pollTimeoutSec: number
  /**
   * Periodically poke opencode so its hardcoded 60-minute idle sweep cannot
   * evict this location and tear the bridge down with it. Disable only if you
   * run something else that keeps the location busy.
   */
  readonly keepAlive: boolean
  /** Let the agent push pictures to Telegram through the `send_telegram_image` tool. */
  readonly imageSend: boolean
  /** Accept photos/image files sent from Telegram and hand them to the agent. */
  readonly imageReceive: boolean
}

const DEFAULTS = {
  apiBase: "https://api.telegram.org",
  stream: true,
  streamIntervalMs: 1500,
  toolNotifications: false,
  typing: true,
  forwardAllSessions: false,
  allSessionPermissions: false,
  allowAllChats: false,
  revealChatID: true,
  announce: true,
  delivery: "steer" as const,
  questionTimeoutMs: 10 * 60_000,
  pollTimeoutSec: 50,
  keepAlive: true,
  imageSend: true,
  imageReceive: true,
}

function env(name: string): string | undefined {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } }
  const value = host.process?.env?.[name]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function ids(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  const out = new Set<string>()
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) out.add(String(Math.trunc(entry)))
    else if (typeof entry === "string" && entry.trim() !== "") out.add(entry.trim())
  }
  return out
}

export function readOptions(raw: Readonly<Record<string, any>>): BridgeOptions {
  const token = text(raw.token) ?? env("TELEGRAM_BOT_TOKEN") ?? env("OPENCODE_TELEGRAM_TOKEN") ?? ""
  const delivery = raw.delivery === "queue" ? "queue" : DEFAULTS.delivery

  return {
    token,
    apiBase: text(raw.apiBase) ?? DEFAULTS.apiBase,
    chatIDs: ids(raw.chatIDs),
    allowAllChats: flag(raw.allowAllChats, DEFAULTS.allowAllChats),
    revealChatID: flag(raw.revealChatID, DEFAULTS.revealChatID),
    announce: flag(raw.announce, DEFAULTS.announce),
    sessionID: text(raw.sessionID),
    delivery,
    stream: flag(raw.stream, DEFAULTS.stream),
    streamIntervalMs: number(raw.streamIntervalMs, DEFAULTS.streamIntervalMs, 250, 30_000),
    toolNotifications: flag(raw.toolNotifications, DEFAULTS.toolNotifications),
    typing: flag(raw.typing, DEFAULTS.typing),
    forwardAllSessions: flag(raw.forwardAllSessions, DEFAULTS.forwardAllSessions),
    allSessionPermissions: flag(raw.allSessionPermissions, DEFAULTS.allSessionPermissions),
    questionTimeoutMs: number(raw.questionTimeoutMs, DEFAULTS.questionTimeoutMs, 5_000, 60 * 60_000),
    pollTimeoutSec: number(raw.pollTimeoutSec, DEFAULTS.pollTimeoutSec, 10, 50),
    keepAlive: flag(raw.keepAlive, DEFAULTS.keepAlive),
    imageSend: flag(raw.imageSend, DEFAULTS.imageSend),
    imageReceive: flag(raw.imageReceive, DEFAULTS.imageReceive),
  }
}
