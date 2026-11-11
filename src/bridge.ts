import type { Context } from "@opencode/plugin/promise/plugin"
import type { BridgeOptions } from "./options.js"
import type { BridgeEvent, PermissionRequestData, QuestionPrompt } from "./events.js"
import { describeFailure } from "./events.js"
import {
  MAX_IMAGE_BYTES,
  captureScreen,
  extensionFor,
  formatBytes,
  pruneMedia,
  readImageFile,
  saveImage,
  toFileUri,
} from "./media.js"
import {
  TelegramBot,
  TelegramError,
  describeError,
  delay,
  fitMessage,
  isAbort,
  splitMessage,
  type InlineButton,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramDocument,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram.js"

function warn(message: string): void {
  console.warn(`[opencode-telegram-bridge] ${message}`)
}

/** Minimum gap between "reconnected" notices so a flapping link can't spam. */
const RECONNECT_NOTICE_MIN_MS = 5 * 60_000

/**
 * Keep-alive poke schedule (see keepAlivePoke).
 *
 * OpenCode 2.1.0 hardcodes a 60-minute idle sweep on location services: an idle
 * location is evicted and every plugin loaded in it is destroyed — including
 * this bridge, which then stays dead until something else boots the location
 * (historically up to half a day). The sweep only extends its deadline for
 * durable session events stamped with a location, so we emit one comfortably
 * before the deadline. 45 minutes leaves a 15-minute margin; the first poke
 * runs almost immediately so a plugin reload (which does not reset the clock)
 * cannot inherit a nearly-expired one.
 */
const KEEP_ALIVE_FIRST_MS = 15_000
const KEEP_ALIVE_INTERVAL_MS = 45 * 60_000
/** A failed poke retries sooner, so several attempts still fit inside the TTL. */
const KEEP_ALIVE_RETRY_MS = 5 * 60_000

interface PermissionCard {
  requestID: string
  sessionID: string
  chatID: number
  messageID: number
  text: string
  save?: string[]
}

interface SessionRow {
  id: string
  title?: string
  directory?: string
  updated?: number
}

interface QuestionWait {
  key: string
  sessionID: string
  chatID: number
  questions: QuestionPrompt[]
  messageIDs: Array<number | undefined>
  /** `null` means the question has not been answered yet. */
  answers: Array<string[] | null>
  selected: Array<Set<number>>
  /** Question index that is waiting for a typed answer, if any. */
  freeText: number | null
  settled: boolean
  resolve: (answers: string[][]) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface StreamState {
  key: string
  chatID: number
  messageID?: number
  buffer: string
  lastEdit: number
  ended: boolean
}

/** One window of the token-usage plugin's `report` RPC result. */
interface TokenUsageWindow {
  id: string
  label?: string
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  calls: number
  cost: number
}

interface TokenUsageReport {
  generatedAt: number
  since: number
  retentionDays: number
  seeded: boolean
  windows: TokenUsageWindow[]
}

const HELP = [
  "🤖 OpenCode ↔ Telegram bridge",
  "",
  "Send any message to pass it to the agent; its answer streams into this chat.",
  "Photos work too: send one (with or without a caption) and the agent sees it.",
  "Ask the agent to show you something — screenshots, charts, project status —",
  "and it replies with a picture through its send_telegram_image tool.",
  "",
  "Commands:",
  "/new — start a fresh agent session",
  "/session — show the bound session",
  "/sessions — list every session on this machine",
  "/switch <n> — rebind the bridge to the n-th session from /sessions",
  "/status — session info and pending permission requests",
  "/tokens — token usage totals per window (needs the token-usage plugin)",
  "/allow [n] — approve the n-th pending permission (default 1)",
  "/deny [n] — reject the n-th pending permission (default 1)",
  "/cancel — interrupt the agent",
  "",
  "Session management:",
  "/models [text] — list models (search with text)",
  "/model <n|provider/id> — switch the bound session's model",
  "/agents — list agents",
  "/agent <n|name> — switch the bound session's agent",
  "/rename <title> — rename the bound session",
  "/compact — compact the bound session",
  "/delete <n> — delete the n-th session from /sessions (asks to confirm)",
  "",
  "/help — this message",
  "",
  "Permission prompts and agent questions arrive as buttons.",
  "With all-session permissions on, prompts from every session in this",
  "project appear here, and /status, /allow, and /deny span them all.",
].join("\n")

export class Bridge {
  private readonly ctx: Context
  private readonly options: BridgeOptions
  private readonly bot: TelegramBot

  private stopped = false
  private offset = 0
  private primaryChat?: number
  private sessionID?: string

  private pollController?: AbortController
  private readonly eventControllers = new Set<AbortController>()

  private readonly trackedCache = new Map<string, boolean>()
  private readonly permCards = new Map<string, PermissionCard>()
  private readonly unsentPermissions = new Map<string, PermissionRequestData>()
  private readonly questions = new Map<string, QuestionWait>()
  private readonly streams = new Map<string, StreamState>()
  private readonly callNames = new Map<string, string>()
  /** Last `/models` result, so `/model <n>` maps to what was on screen. */
  private modelChoices: Array<{ providerID: string; id: string; name?: string; variant?: string }> = []
  /** Sessions awaiting a delete confirmation tap, keyed by session ID. */
  private readonly pendingDeletes = new Map<string, { title: string }>()
  /** When the last "reconnected" notice went out (0 = never). */
  private lastReconnectNotice = 0
  /** Pending keep-alive poke (see keepAlivePoke). */
  private keepAliveTimer?: ReturnType<typeof setTimeout>

  constructor(ctx: Context, options: BridgeOptions, bot: TelegramBot) {
    this.ctx = ctx
    this.options = options
    this.bot = bot
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    const storedChat = await this.ctx.storage.get("chat")
    if (typeof storedChat === "number") this.primaryChat = storedChat

    const storedSession = await this.ctx.storage.get("session")
    this.sessionID =
      this.options.sessionID ?? (typeof storedSession === "string" && storedSession !== "" ? storedSession : undefined)
    if (this.options.sessionID) await this.ctx.storage.set("session", this.options.sessionID)

    const storedOffset = await this.ctx.storage.get("offset")
    this.offset = typeof storedOffset === "number" && storedOffset > 0 ? storedOffset : await this.latestUpdateID()

    await this.bot
      .setMyCommands([
        { command: "help", description: "How the bridge works" },
        { command: "new", description: "Start a fresh agent session" },
        { command: "status", description: "Session and permission status" },
        { command: "tokens", description: "Show token usage" },
        { command: "session", description: "Show the bound session" },
        { command: "sessions", description: "List every session on this machine" },
        { command: "switch", description: "Rebind the bridge to a session" },
        { command: "allow", description: "Approve a pending permission" },
        { command: "deny", description: "Reject a pending permission" },
        { command: "models", description: "List models" },
        { command: "model", description: "Switch the session model" },
        { command: "agents", description: "List agents" },
        { command: "agent", description: "Switch the session agent" },
        { command: "rename", description: "Rename the session" },
        { command: "compact", description: "Compact the session" },
        { command: "delete", description: "Delete a session" },
        { command: "cancel", description: "Interrupt the agent" },
      ])
      .catch(() => undefined)

    this.pollController = new AbortController()
    void this.pollLoop()
    void this.eventLoop()
    // Keep the hosting location from idling out (see keepAlivePoke). Fires once
    // almost immediately: a plugin reload restarts this timer but not the
    // location's clock, so the first poke must not wait a whole interval.
    if (this.options.keepAlive) this.scheduleKeepAlive(KEEP_ALIVE_FIRST_MS)
    // Sweep week-old Telegram downloads; best-effort and never rejects.
    void pruneMedia()

    // Deliberately NO "connected" announce here. OpenCode reloads this plugin on
    // every reconciliation (TUI opens, config edits, CLI runs) and each reload
    // re-ran start(), spamming "connected" every time. The only announce worth
    // sending is a real reconnect after an outage — see announceReconnect().
    await this.replayPendingPermissions()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    // Kill inbound polling FIRST. A hung flush must never leave a stale loop
    // running beside the replacement instance — two loops fight over getUpdates
    // and Telegram answers 409, killing both.
    this.pollController?.abort()
    // Flush partial output best-effort, bounded so a dead Telegram cannot wedge
    // teardown (which would stop the next bridge from ever starting). The
    // helpers still send because `stopped` is only set after the flush.
    await Promise.race([
      (async () => {
        for (const stream of [...this.streams.values()]) await this.finalizeStream(stream)
      })(),
      delay(10_000),
    ]).catch(() => undefined)
    this.stopped = true
    if (this.keepAliveTimer !== undefined) clearTimeout(this.keepAliveTimer)
    this.keepAliveTimer = undefined
    for (const controller of this.eventControllers) controller.abort()
    this.eventControllers.clear()
    for (const wait of [...this.questions.values()]) this.settleQuestion(wait, "cancelled")
  }

  /** Schedule the next keep-alive poke (see keepAlivePoke). */
  private scheduleKeepAlive(delayMs: number): void {
    if (this.stopped) return
    if (this.keepAliveTimer !== undefined) clearTimeout(this.keepAliveTimer)
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = undefined
      void this.keepAlivePoke()
    }, delayMs)
  }

  /**
   * Reset OpenCode's idle clock for this location so an away-from-keyboard
   * stretch cannot evict it and take the bridge down with it.
   *
   * The sweep only counts durable session events whose payload carries a
   * location envelope, and `bus.publish` fills that envelope from the Effect
   * context's `Location.Service`. The promise adapter runs plugin-triggered
   * host effects on a bare Scope+Logger runtime, so every per-session event a
   * plugin can cause (rename, metadata, permissions, agent/model switch, ...)
   * reaches the bus with NO location and the sweep skips it — which is why the
   * original rename poke kept firing yet the location still evicted at
   * 06:34:39Z, exactly 60 minutes after the last real activity.
   *
   * `Session.create` is the exception: it publishes `session.created` with an
   * explicit `{ location }` publish option (the host injects this plugin's own
   * location), bypassing the context lookup entirely. Creating a throwaway
   * session therefore guarantees a touch; removing it right after keeps it out
   * of /sessions. Net zero sessions, one guaranteed touch, no model call, and
   * no dependency on being bound to a session.
   */
  private async keepAlivePoke(): Promise<void> {
    if (this.stopped) return
    let delay = KEEP_ALIVE_INTERVAL_MS
    let outcome = "ok"
    let detail = ""
    // Unique per poke (the ID schema only requires the "ses" prefix) so a
    // session leaked by a failed remove can never collide on a later retry.
    const sid = `ses_keepalive${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    try {
      await this.ctx.session.create({ id: sid, title: "telegram-bridge keep-alive" })
      detail = `created ${sid}`
    } catch (error) {
      outcome = `error: ${describeError(error)}`
      warn(`keep-alive poke failed: ${describeError(error)}`)
      delay = KEEP_ALIVE_RETRY_MS
    }
    // Hygiene only: session.deleted carries no location envelope, but the
    // throwaway must not pile up in /sessions. Runs even when create's
    // response failed after the session already existed, and a not-found
    // remove after a genuine create failure is harmless.
    try {
      await this.ctx.session.remove({ sessionID: sid })
      detail += " + removed"
    } catch (error) {
      detail += ` + remove-failed: ${describeError(error)}`
    }
    // console.warn never reaches opencode's log, so the kv store is the only
    // durable record of whether a poke ran (and why one failed).
    await this.ctx.storage
      .set("lastPoke", `${new Date().toISOString()} | ${outcome} | ${detail} | next in ${Math.round(delay / 60_000)}m`)
      .catch(() => undefined)
    this.scheduleKeepAlive(delay)
  }

  /** Discard updates queued before the bridge ever ran, so old chats are not replayed. */
  private async latestUpdateID(): Promise<number> {
    try {
      const updates = await this.bot.getUpdates(-1, 0, undefined, 1)
      const last = updates[updates.length - 1]
      return last ? last.update_id + 1 : 0
    } catch (error) {
      warn(`could not read the Telegram backlog: ${describeError(error)}`)
      return 0
    }
  }

  // ------------------------------------------------------------------- output

  private primaryChatId(): number | undefined {
    if (this.primaryChat !== undefined) return this.primaryChat
    for (const id of this.options.chatIDs) {
      const numeric = Number(id)
      if (Number.isFinite(numeric) && Math.trunc(numeric) === numeric) return numeric
    }
    return undefined
  }

  private authorized(chatID: number): boolean {
    if (this.options.allowAllChats) return true
    return this.options.chatIDs.has(String(chatID))
  }

  private async safeSendTo(
    chatID: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<TelegramMessage | undefined> {
    if (this.stopped) return undefined
    try {
      return await this.bot.sendMessage(chatID, text, { replyMarkup: keyboard })
    } catch (error) {
      if (!isAbort(error)) warn(`sendMessage failed: ${describeError(error)}`)
      return undefined
    }
  }

  private async safeEdit(chatID: number, messageID: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.stopped) return
    try {
      await this.bot.editMessageText(chatID, messageID, text, { replyMarkup: keyboard })
    } catch (error) {
      if (error instanceof TelegramError && error.benign) return
      if (!isAbort(error)) warn(`editMessageText failed: ${describeError(error)}`)
    }
  }

  private async notify(text: string, keyboard?: InlineKeyboard): Promise<void> {
    const chatID = this.primaryChatId()
    if (chatID === undefined) return
    await this.safeSendTo(chatID, text, keyboard)
  }

  // -------------------------------------------------------------- event stream

  private async eventLoop(): Promise<void> {
    let failures = 0
    // Mirror pollLoop: only an explicit stop ends this. A transient abort must
    // not kill the event stream, or streaming output and permission prompts die
    // silently while polling keeps working (a half-dead bridge).
    while (!this.stopped) {
      const controller = new AbortController()
      this.eventControllers.add(controller)
      try {
        for await (const raw of this.ctx.event.subscribe({ signal: controller.signal })) {
          if (this.stopped) return
          failures = 0
          const event = raw as unknown as BridgeEvent
          try {
            await this.onEvent(event)
          } catch (error) {
            warn(`event ${event.type} failed: ${describeError(error)}`)
          }
        }
      } catch (error) {
        if (this.stopped) return
        failures++
        warn(`event stream ended (attempt ${failures}): ${describeError(error)}`)
      } finally {
        this.eventControllers.delete(controller)
      }
      if (this.stopped) return
      // 3s after a clean end; 3s/6s/12s/24s/cap-30s while it keeps failing.
      await delay(failures > 0 ? Math.min(30_000, 3_000 * 2 ** Math.min(failures - 1, 4)) : 3_000)
    }
  }

  private async onEvent(event: BridgeEvent): Promise<void> {
    const location = event.location
    if (location && location.directory !== this.ctx.location.directory) return
    const data = event.data ?? {}

    switch (event.type) {
      case "permission.asked": {
        const request = data as unknown as PermissionRequestData
        if (!request?.id || !request.sessionID) return
        if (!(await this.trackedPermission(request.sessionID))) return
        await this.notifyPermission(request)
        return
      }
      case "permission.replied": {
        const card = typeof data.requestID === "string" ? this.permCards.get(data.requestID) : undefined
        if (!card) return
        this.permCards.delete(card.requestID)
        await this.safeEdit(card.chatID, card.messageID, `${card.text}\n\n${repliedLabel(data.reply)}`)
        return
      }
      case "form.created": {
        // Safety net: a form this plugin could not take over (another plugin's
        // form, or a failed question-tool override) still has to be visible.
        const form = data.form
        if (!form?.sessionID || !(await this.tracked(form.sessionID))) return
        const chatID = this.primaryChatId()
        if (chatID === undefined) return
        await this.safeSendTo(
          chatID,
          `❓ ${form.title ?? "A question was created"}\n\nAnswer it in the OpenCode interface — the Telegram bridge could not take this one over.`,
        )
        return
      }
      case "session.execution.started": {
        if (!this.options.typing) return
        if (!(await this.tracked(data.sessionID))) return
        const chatID = this.primaryChatId()
        if (chatID !== undefined) void this.bot.sendChatAction(chatID, "typing").catch(() => undefined)
        return
      }
      case "session.execution.failed": {
        if (!(await this.tracked(data.sessionID))) return
        await this.notify(`⚠️ The session failed: ${describeFailure(data.error)}`)
        return
      }
      case "session.execution.interrupted": {
        await this.finalizeSessionStreams(data.sessionID)
        if (!(await this.tracked(data.sessionID))) return
        const reason = typeof data.reason === "string" && data.reason !== "" ? ` (${data.reason})` : ""
        await this.notify(`⏹ The session was interrupted${reason}.`)
        return
      }
      case "session.text.started":
        await this.startStream(data)
        return
      case "session.text.delta": {
        const stream = this.streams.get(streamKey(data))
        if (!stream) return
        if (typeof data.delta === "string") stream.buffer += data.delta
        if (stream.messageID === undefined) return
        const now = Date.now()
        if (now - stream.lastEdit < this.options.streamIntervalMs) return
        stream.lastEdit = now
        await this.safeEdit(stream.chatID, stream.messageID, fitMessage(`${stream.buffer}▍`))
        return
      }
      case "session.text.ended": {
        const stream = this.streams.get(streamKey(data))
        if (!stream) {
          if (typeof data.text === "string" && data.text !== "" && (await this.tracked(data.sessionID))) {
            await this.notify(data.text)
          }
          return
        }
        if (typeof data.text === "string") stream.buffer = data.text
        await this.finalizeStream(stream)
        return
      }
      case "session.idle":
        await this.finalizeSessionStreams(data.sessionID)
        return
      case "session.tool.input.started": {
        if (!this.options.toolNotifications) return
        if (typeof data.id === "string" && typeof data.name === "string") this.callNames.set(data.id, data.name)
        if (typeof data.name === "string" && (await this.tracked(data.sessionID))) await this.notify(`🔧 ${data.name}`)
        return
      }
      case "session.tool.success": {
        if (!this.options.toolNotifications) return
        const name = typeof data.id === "string" ? this.callNames.get(data.id) : undefined
        if (typeof data.id === "string") this.callNames.delete(data.id)
        if (name && (await this.tracked(data.sessionID))) await this.notify(`✅ ${name}`)
        return
      }
      case "session.tool.failed": {
        if (!this.options.toolNotifications) return
        const name = typeof data.id === "string" ? this.callNames.get(data.id) : undefined
        if (typeof data.id === "string") this.callNames.delete(data.id)
        if (name && (await this.tracked(data.sessionID))) await this.notify(`❌ ${name}: ${describeFailure(data.error)}`)
        return
      }
      default:
        return
    }
  }

  /**
   * Only the bridged session (and its subagents) are mirrored into Telegram.
   * The parent chain is walked once per session and cached.
   */
  private async tracked(sessionID: unknown): Promise<boolean> {
    if (typeof sessionID !== "string" || sessionID === "") return false
    if (this.options.forwardAllSessions) return true
    const bound = this.sessionID
    if (!bound) return false
    if (sessionID === bound) return true
    const cached = this.trackedCache.get(sessionID)
    if (cached !== undefined) return cached

    let result = false
    let current: string | undefined = sessionID
    for (let depth = 0; current !== undefined && depth < 10; depth++) {
      if (current === bound) {
        result = true
        break
      }
      let parent: string | undefined
      try {
        parent = (await this.ctx.session.get({ sessionID: current })).parentID
      } catch {
        break
      }
      current = parent
    }
    this.trackedCache.set(sessionID, result)
    return result
  }

  /** Permission requests are mirrored for every session when `allSessionPermissions` is on. */
  private async trackedPermission(sessionID: unknown): Promise<boolean> {
    if (this.options.allSessionPermissions) return true
    return this.tracked(sessionID)
  }

  // --------------------------------------------------------------- permissions

  private renderPermission(request: PermissionRequestData): string {
    const lines = ["🔐 Permission required", "", `Action: ${request.action}`, "Resource:"]
    for (const resource of request.resources.slice(0, 12)) lines.push(`• ${resource}`)
    if (request.resources.length > 12) lines.push(`• … and ${request.resources.length - 12} more`)
    if (request.save?.length) lines.push("", `Allow-always would save: ${request.save.join(", ")}`)
    if (request.message) lines.push("", request.message)
    return lines.join("\n")
  }

  private permissionKeyboard(request: PermissionRequestData): InlineKeyboard {
    const row: InlineButton[] = [{ text: "✅ Allow once", callback_data: `p:${request.id}:once` }]
    if (request.save?.length) row.push({ text: "♻️ Allow always", callback_data: `p:${request.id}:always` })
    return { inline_keyboard: [row, [{ text: "❌ Reject", callback_data: `p:${request.id}:reject` }]] }
  }

  private async notifyPermission(request: PermissionRequestData): Promise<void> {
    if (this.permCards.has(request.id) || this.unsentPermissions.has(request.id)) return
    const chatID = this.primaryChatId()
    if (chatID === undefined) {
      // Nobody to talk to yet; flush the card as soon as a chat identifies itself.
      this.unsentPermissions.set(request.id, request)
      return
    }
    const text = this.renderPermission(request)
    const message = await this.safeSendTo(chatID, text, this.permissionKeyboard(request))
    if (!message) return
    this.unsentPermissions.delete(request.id)
    this.permCards.set(request.id, {
      requestID: request.id,
      sessionID: request.sessionID,
      chatID,
      messageID: message.message_id,
      text,
      save: request.save,
    })
  }

  /**
   * Walk sessions (newest first, following cursor pages).
   * Scope to a directory, to top-level only (`parentID: null`), both, or neither (every session on the machine).
   */
  private async *listSessions(scope: { directory?: string; parentID?: string | null } = {}): AsyncGenerator<SessionRow> {
    const list = this.ctx.session.list.bind(this.ctx.session) as unknown as (query: Record<string, unknown>) => Promise<{
      data: Array<Record<string, any>>
      cursor?: { next?: unknown }
    }>
    let cursor: unknown
    for (let page = 0; page < 20; page++) {
      const result = await list({
        ...(scope.directory !== undefined ? { directory: scope.directory } : {}),
        ...(scope.parentID !== undefined ? { parentID: scope.parentID } : {}),
        order: "desc",
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (const session of result.data) {
        yield {
          id: session.id,
          title: session.title,
          directory: session.location?.directory,
          updated: session.time?.updated,
        }
      }
      cursor = result.cursor?.next
      if (cursor === undefined) return
    }
  }

  /** Every top-level session on this machine (all projects), newest first. */
  private async machineSessions(): Promise<SessionRow[]> {
    const out: SessionRow[] = []
    try {
      for await (const session of this.listSessions({ parentID: null })) out.push(session)
    } catch (error) {
      warn(`could not list sessions: ${describeError(error)}`)
    }
    return out
  }

  /** Pending requests grouped by session; only populated across every session when `allSessionPermissions` is on. */
  private async pendingPermissionEntries(): Promise<
    Array<{ sessionID: string; title: string; requests: PermissionRequestData[] }>
  > {
    const out: Array<{ sessionID: string; title: string; requests: PermissionRequestData[] }> = []
    try {
      for await (const session of this.listSessions({ directory: String(this.ctx.location.directory) })) {
        let requests: PermissionRequestData[] = []
        try {
          requests = this.unwrapList(
            await this.ctx.permission.list({ sessionID: session.id }),
            "permission.list",
          ) as PermissionRequestData[]
        } catch {
          // The session may have been deleted between listing and reading; skip it.
        }
        out.push({ sessionID: session.id, title: session.title ?? session.id, requests })
      }
    } catch (error) {
      warn(`could not list sessions for permission replay: ${describeError(error)}`)
    }
    return out
  }

  /** Flat list of pending requests: every session when `allSessionPermissions` is on, else the bound one. */
  private async pendingPermissionRequests(): Promise<PermissionRequestData[]> {
    if (this.options.allSessionPermissions) {
      return (await this.pendingPermissionEntries()).flatMap((entry) => entry.requests)
    }
    if (!this.sessionID) return []
    try {
      return this.unwrapList(
        await this.ctx.permission.list({ sessionID: this.sessionID }),
        "permission.list",
      ) as PermissionRequestData[]
    } catch (error) {
      warn(`could not list pending permissions: ${describeError(error)}`)
      return []
    }
  }

  private async replayPendingPermissions(): Promise<void> {
    const requests = await this.pendingPermissionRequests()
    for (const request of requests) await this.notifyPermission(request)
  }

  private async flushUnsentPermissions(): Promise<void> {
    if (this.unsentPermissions.size === 0) return
    const pending = [...this.unsentPermissions.values()]
    this.unsentPermissions.clear()
    for (const request of pending) await this.notifyPermission(request)
  }

  private async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
  ): Promise<void> {
    await this.ctx.permission.reply({
      sessionID,
      requestID,
      decision,
      ...(decision === "reject" ? { message: "Rejected from Telegram." } : {}),
    })
  }

  private async closePermissionCard(requestID: string, label: string): Promise<void> {
    const card = this.permCards.get(requestID)
    if (!card) return
    this.permCards.delete(requestID)
    await this.safeEdit(card.chatID, card.messageID, `${card.text}\n\n${label}`)
  }

  // ----------------------------------------------------------------- questions

  private newQuestionKey(): string {
    for (;;) {
      const key = Math.random().toString(36).slice(2, 10)
      if (key.length > 0 && !this.questions.has(key)) return key
    }
  }

  private renderQuestion(wait: QuestionWait, index: number, suffix?: string): string {
    const question = wait.questions[index]
    const header = question.header ?? `Question ${index + 1}/${wait.questions.length}`
    const lines = [`❓ ${header}`, "", question.question, ""]
    if (question.options?.length) {
      question.options.forEach((option, optionIndex) => {
        lines.push(`${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)
      })
      lines.push("")
    }
    lines.push(question.multiple ? "Tap to pick one or more, then Done." : "Tap an answer, or send your own.")
    if (wait.answers[index]?.length) lines.push("", `✅ Answered: ${wait.answers[index]?.join(", ")}`)
    if (suffix) lines.push("", suffix)
    return lines.join("\n")
  }

  private renderQuestionKeyboard(wait: QuestionWait, index: number): InlineKeyboard | undefined {
    const question = wait.questions[index]
    if (wait.answers[index] !== null) return undefined // answered: drop the buttons
    const keyboard: InlineButton[][] = []
    const options = question.options ?? []
    if (question.multiple) {
      const selected = wait.selected[index] ?? new Set<number>()
      options.forEach((option, optionIndex) => {
        keyboard.push([
          {
            text: `${selected.has(optionIndex) ? "✅ " : ""}${fitMessage(option.label, 60)}`,
            callback_data: `q:${wait.key}:${index}:${optionIndex}`,
          },
        ])
      })
      keyboard.push([
        { text: "🧹 Clear", callback_data: `q:${wait.key}:${index}:c` },
        { text: "👍 Done", callback_data: `q:${wait.key}:${index}:d` },
      ])
    } else {
      options.forEach((option, optionIndex) => {
        keyboard.push([{ text: fitMessage(option.label, 64), callback_data: `q:${wait.key}:${index}:${optionIndex}` }])
      })
    }
    keyboard.push([{ text: "✏️ Type your own answer", callback_data: `q:${wait.key}:${index}:f` }])
    return { inline_keyboard: keyboard }
  }

  private async redrawQuestion(wait: QuestionWait, index: number, suffix?: string): Promise<void> {
    const messageID = wait.messageIDs[index]
    if (messageID === undefined) return
    await this.safeEdit(
      wait.chatID,
      messageID,
      this.renderQuestion(wait, index, suffix),
      this.renderQuestionKeyboard(wait, index),
    )
  }

  private async setQuestionAnswer(wait: QuestionWait, index: number, values: string[]): Promise<void> {
    if (wait.settled || wait.answers[index] !== null) return
    wait.answers[index] = values
    wait.freeText = null
    await this.redrawQuestion(wait, index)
    if (wait.answers.every((answer) => answer !== null)) this.settleQuestion(wait, "answered")
  }

  /** Synchronous settle; follow-up notices are fired and not awaited on purpose. */
  private settleQuestion(wait: QuestionWait, outcome: "answered" | "timeout" | "cancelled"): void {
    if (wait.settled) return
    wait.settled = true
    if (wait.timer !== undefined) clearTimeout(wait.timer)
    this.questions.delete(wait.key)

    if (outcome === "cancelled") {
      void this.noteUnanswered(wait, "⏹ Cancelled.")
      wait.reject(new Error("The question was cancelled before the user answered."))
      return
    }
    if (outcome === "timeout") void this.noteUnanswered(wait, "⏱ No answer (timed out).")
    wait.resolve(wait.answers.map((answer) => answer ?? []))
  }

  private async noteUnanswered(wait: QuestionWait, note: string): Promise<void> {
    for (let index = 0; index < wait.answers.length; index++) {
      if (wait.answers[index] !== null) continue
      const messageID = wait.messageIDs[index]
      if (messageID === undefined) continue
      await this.safeEdit(wait.chatID, messageID, `${this.renderQuestion(wait, index)}\n\n${note}`)
    }
  }

  /**
   * Ask the agent's questions in Telegram and resolve with one answer list per
   * question (an empty list means "Unanswered", matching the built-in tool).
   */
  async askQuestions(sessionID: string, questions: QuestionPrompt[], signal?: AbortSignal): Promise<string[][]> {
    const chatID = this.primaryChatId()
    if (chatID === undefined) {
      throw new Error(
        "No authorized Telegram chat is available yet. Send a message from an allowed chat first, then ask the question again.",
      )
    }

    const key = this.newQuestionKey()
    let resolve!: (answers: string[][]) => void
    let reject!: (error: Error) => void
    const done = new Promise<string[][]>((res, rej) => {
      resolve = res
      reject = rej
    })

    const wait: QuestionWait = {
      key,
      sessionID,
      chatID,
      questions,
      messageIDs: questions.map(() => undefined),
      answers: questions.map(() => null),
      selected: questions.map(() => new Set<number>()),
      freeText: null,
      settled: false,
      resolve,
      reject,
    }
    wait.timer = setTimeout(() => this.settleQuestion(wait, "timeout"), this.options.questionTimeoutMs)
    this.questions.set(key, wait)

    const onAbort = () => this.settleQuestion(wait, "cancelled")
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      for (let index = 0; index < questions.length; index++) {
        const message = await this.safeSendTo(
          chatID,
          this.renderQuestion(wait, index),
          this.renderQuestionKeyboard(wait, index),
        )
        if (wait.settled) break
        if (!message) throw new Error("Telegram did not accept the question message.")
        wait.messageIDs[index] = message.message_id
      }
      return await done
    } finally {
      signal?.removeEventListener("abort", onAbort)
      if (wait.timer !== undefined) clearTimeout(wait.timer)
      this.questions.delete(key)
      wait.settled = true
    }
  }

  // ----------------------------------------------------------------- streaming

  private async startStream(data: Record<string, any>): Promise<void> {
    const key = streamKey(data)
    if (this.streams.has(key)) return
    if (!(await this.tracked(data.sessionID))) return
    const chatID = this.primaryChatId()
    if (chatID === undefined) return

    // Register before the placeholder round-trip so early deltas are buffered.
    const stream: StreamState = { key, chatID, buffer: "", lastEdit: 0, ended: false }
    this.streams.set(key, stream)
    if (this.options.stream) {
      const message = await this.safeSendTo(chatID, "…")
      if (message) stream.messageID = message.message_id
    }
    if (this.stopped) this.streams.delete(key)
  }

  private async finalizeStream(stream: StreamState): Promise<void> {
    if (stream.ended) return
    stream.ended = true
    this.streams.delete(stream.key)
    if (this.stopped) return

    const text = stream.buffer
    const chunks = splitMessage(text.trim().length > 0 ? text : "⏹ (no output)")

    if (stream.messageID !== undefined) {
      await this.safeEdit(stream.chatID, stream.messageID, chunks[0] ?? "")
      for (let index = 1; index < chunks.length; index++) await this.safeSendTo(stream.chatID, chunks[index] ?? "")
      return
    }
    for (const chunk of chunks) await this.safeSendTo(stream.chatID, chunk)
  }

  private async finalizeSessionStreams(sessionID: unknown): Promise<void> {
    if (typeof sessionID !== "string") return
    for (const stream of [...this.streams.values()]) {
      if (stream.key.startsWith(`${sessionID}::`)) await this.finalizeStream(stream)
    }
  }

  // ------------------------------------------------------------------- polling

  private async pollLoop(): Promise<void> {
    let failures = 0
    // Only an explicit stop ends polling. A transient abort/timeout from the
    // fetch layer (flaky network, socket reset) must NOT kill this loop — that
    // was how the bridge silently stopped reconnecting: `isAbort()` also matches
    // TimeoutError, so one bad blip took the whole bridge down for good.
    while (!this.stopped && !this.pollController?.signal.aborted) {
      try {
        const updates = await this.bot.getUpdates(this.offset, this.options.pollTimeoutSec, this.pollController?.signal)
        if (this.stopped) return
        // Two+ consecutive failures = a genuine outage, not a single blip.
        // This is the ONLY announce the bridge sends now.
        if (failures >= 2) this.announceReconnect(failures)
        failures = 0
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          try {
            await this.handleUpdate(update)
          } catch (error) {
            warn(`update ${update.update_id} failed: ${describeError(error)}`)
          }
        }
        if (updates.length > 0) await this.ctx.storage.set("offset", this.offset)
      } catch (error) {
        if (this.stopped || this.pollController?.signal.aborted) return
        failures++
        warn(`polling failed (attempt ${failures}): ${describeError(error)}`)
        // 3s, 6s, 12s, 24s, then capped at 30s; reset on the next clean poll.
        await delay(Math.min(30_000, 3_000 * 2 ** Math.min(failures - 1, 4)))
      }
    }
  }

  /**
   * One quiet "we're back" after a real outage. Never fires on plugin reload
   * (a fresh instance starts with `failures = 0`), and rate-limited so a
   * flapping connection can't nag.
   */
  private announceReconnect(failures: number): void {
    if (!this.options.announce) return
    const now = Date.now()
    if (now - this.lastReconnectNotice < RECONNECT_NOTICE_MIN_MS) return
    this.lastReconnectNotice = now
    const chatID = this.primaryChatId()
    if (chatID === undefined) return
    void this.safeSendTo(chatID, `🟢 Telegram reconnected after ${failures} failed attempt${failures === 1 ? "" : "s"}.`).catch(
      () => undefined,
    )
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query)
      return
    }
    if (update.message) await this.handleMessage(update.message)
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const chatID = callback.message?.chat.id
    const data = callback.data ?? ""
    if (chatID === undefined) {
      await this.bot.answerCallbackQuery(callback.id)
      return
    }
    if (!this.authorized(chatID)) {
      await this.bot.answerCallbackQuery(callback.id, "This chat is not authorized.", true)
      return
    }
    if (data.startsWith("p:")) {
      await this.handlePermissionCallback(callback, chatID)
      return
    }
    if (data.startsWith("q:")) {
      await this.handleQuestionCallback(callback, chatID)
      return
    }
    if (data.startsWith("d:")) {
      await this.handleDeleteCallback(callback, chatID)
      return
    }
    await this.bot.answerCallbackQuery(callback.id)
  }

  private async handlePermissionCallback(callback: TelegramCallbackQuery, chatID: number): Promise<void> {
    const parts = (callback.data ?? "").split(":")
    const requestID = parts[1]
    const choice = parts[2]
    const card = requestID ? this.permCards.get(requestID) : undefined
    if (!card || card.chatID !== chatID || (choice !== "once" && choice !== "always" && choice !== "reject")) {
      await this.bot.answerCallbackQuery(callback.id, "This prompt has expired.", true)
      return
    }

    try {
      await this.replyPermission(card.sessionID, card.requestID, choice)
    } catch (error) {
      await this.bot.answerCallbackQuery(callback.id, `Could not reply: ${describeError(error)}`, true)
      return
    }

    const label =
      choice === "once"
        ? "✅ Allowed once"
        : choice === "always"
          ? `♻️ Allowed and saved${card.save?.length ? ` (${card.save.join(", ")})` : ""}`
          : "❌ Rejected — every pending request in this session was rejected"
    await this.bot.answerCallbackQuery(callback.id, "✅ Done")
    await this.closePermissionCard(card.requestID, label)
  }

  private async handleDeleteCallback(callback: TelegramCallbackQuery, chatID: number): Promise<void> {
    const parts = (callback.data ?? "").split(":")
    const sessionID = parts[1] ?? ""
    const action = parts[2]
    const pending = this.pendingDeletes.get(sessionID)
    const messageID = callback.message?.message_id
    if (!pending || messageID === undefined || (action !== "y" && action !== "n")) {
      await this.bot.answerCallbackQuery(callback.id, "This prompt has expired.", true)
      return
    }

    if (action === "n") {
      this.pendingDeletes.delete(sessionID)
      await this.bot.answerCallbackQuery(callback.id, "Cancelled")
      await this.safeEdit(chatID, messageID, `❌ Delete cancelled.\n\n${pending.title}`)
      return
    }

    try {
      await this.ctx.session.remove({ sessionID })
    } catch (error) {
      await this.bot.answerCallbackQuery(callback.id, `Could not delete: ${describeError(error)}`, true)
      return
    }

    this.pendingDeletes.delete(sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.trackedCache.clear()
      await this.ctx.storage.set("session", "")
      for (const wait of [...this.questions.values()]) this.settleQuestion(wait, "cancelled")
    }
    await this.bot.answerCallbackQuery(callback.id, "🗑 Deleted")
    await this.safeEdit(chatID, messageID, `🗑 Deleted ${pending.title}.`)
  }

  private async handleQuestionCallback(callback: TelegramCallbackQuery, chatID: number): Promise<void> {
    const parts = (callback.data ?? "").split(":")
    const key = parts[1]
    const index = Number(parts[2])
    const action = parts[3]
    const wait = key ? this.questions.get(key) : undefined
    if (!wait || wait.settled || wait.chatID !== chatID || !Number.isInteger(index) || index < 0 || index >= wait.questions.length) {
      await this.bot.answerCallbackQuery(callback.id, "This question has expired.", true)
      return
    }

    const question = wait.questions[index]
    if (wait.answers[index] !== null) {
      await this.bot.answerCallbackQuery(callback.id, "Already answered.")
      return
    }

    if (action === "f") {
      wait.freeText = index
      await this.bot.answerCallbackQuery(callback.id)
      await this.redrawQuestion(wait, index, "✏️ Send your answer as a message.")
      return
    }

    if (action === "c") {
      wait.selected[index]?.clear()
      wait.freeText = null
      await this.bot.answerCallbackQuery(callback.id)
      await this.redrawQuestion(wait, index)
      return
    }

    if (action === "d") {
      const picked = [...(wait.selected[index] ?? [])]
        .map((optionIndex) => question.options?.[optionIndex]?.label)
        .filter((label): label is string => typeof label === "string")
      if (picked.length === 0) {
        await this.bot.answerCallbackQuery(callback.id, "Pick at least one option.", true)
        return
      }
      await this.bot.answerCallbackQuery(callback.id)
      await this.setQuestionAnswer(wait, index, picked)
      return
    }

    const optionIndex = Number(action)
    const label = Number.isInteger(optionIndex) ? question.options?.[optionIndex]?.label : undefined
    if (!label) {
      await this.bot.answerCallbackQuery(callback.id, "This option is no longer available.", true)
      return
    }

    if (question.multiple) {
      const selected = wait.selected[index]
      if (selected?.has(optionIndex)) selected.delete(optionIndex)
      else selected?.add(optionIndex)
      await this.bot.answerCallbackQuery(callback.id)
      await this.redrawQuestion(wait, index)
      return
    }

    await this.bot.answerCallbackQuery(callback.id)
    await this.setQuestionAnswer(wait, index, [label])
  }

  // ------------------------------------------------------------------- inbound

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatID = message.chat.id
    if (!this.authorized(chatID)) {
      if (this.options.revealChatID) {
        await this.safeSendTo(
          chatID,
          [
            "This chat is not allowed to drive OpenCode.",
            "",
            `Your chat ID: ${chatID}`,
            'Add it to the plugin\'s "chatIDs" option, then restart the OpenCode service.',
          ].join("\n"),
        )
      }
      return
    }

    const firstContact = this.primaryChat === undefined
    this.primaryChat = chatID
    if (firstContact || (await this.ctx.storage.get("chat")) !== chatID) {
      await this.ctx.storage.set("chat", chatID)
    }
    await this.flushUnsentPermissions()

    // Media messages carry their text in `caption`; images ride along as
    // attachments the agent can actually see.
    const text = (message.text ?? message.caption ?? "").trim()
    const hasImage = this.hasImageAttachment(message)
    if (hasImage && !this.options.imageReceive) {
      await this.safeSendTo(
        chatID,
        'Incoming images are disabled — set "imageReceive": true in the plugin options to show them to the agent.',
      )
    }

    let files: Array<{ uri: string; name: string }> = []
    if (hasImage && this.options.imageReceive) {
      const downloaded = await this.downloadImages(message)
      files = downloaded.files
      if (downloaded.errors.length > 0) {
        await this.safeSendTo(chatID, `Could not fetch the image(s) from Telegram: ${downloaded.errors.join("; ")}`)
      }
    }

    if (text === "" && files.length === 0) {
      // A disabled or failed image already reported itself above; only a
      // genuinely unsupported message (e.g. a sticker) gets the generic reply.
      if (!hasImage) await this.safeSendTo(chatID, "Only text messages and images are supported by the bridge.")
      return
    }
    if (text.startsWith("/")) {
      await this.handleCommand(chatID, text)
      return
    }
    if (text !== "" && (await this.consumeAnswerText(chatID, text))) return
    await this.sendToSession(chatID, text, files)
  }

  /** True when the message carries a photo or an image document. */
  private hasImageAttachment(message: TelegramMessage): boolean {
    if (message.photo && message.photo.length > 0) return true
    return message.document !== undefined && this.isImageDocument(message.document)
  }

  private isImageDocument(doc: TelegramDocument): boolean {
    const mime = doc.mime_type?.toLowerCase() ?? ""
    if (mime.startsWith("image/")) return true
    // Some clients omit the mime type; fall back to the filename extension.
    if (mime === "") return /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(doc.file_name ?? "")
    return false
  }

  /**
   * Download the message's photo (largest size) and/or image document into the
   * media directory, returning `file://` attachments for `session.prompt`.
   * Failures are collected per file so one bad attachment never drops the rest.
   */
  private async downloadImages(
    message: TelegramMessage,
  ): Promise<{ files: Array<{ uri: string; name: string }>; errors: string[] }> {
    const wanted: Array<{ fileID: string; name: string; size?: number }> = []
    const photo = message.photo
    if (photo && photo.length > 0) {
      const largest = photo.reduce((best, size) => ((size.file_size ?? 0) > (best.file_size ?? 0) ? size : best), photo[0])
      wanted.push({ fileID: largest.file_id, name: `telegram-${message.message_id}.jpg`, size: largest.file_size })
    }
    const doc = message.document
    if (doc && this.isImageDocument(doc)) {
      wanted.push({ fileID: doc.file_id, name: this.documentFilename(message, doc), size: doc.file_size })
    }

    const files: Array<{ uri: string; name: string }> = []
    const errors: string[] = []
    for (const item of wanted) {
      try {
        if (item.size !== undefined && item.size > MAX_IMAGE_BYTES) {
          throw new Error(`too large (${formatBytes(item.size)}, limit ${formatBytes(MAX_IMAGE_BYTES)})`)
        }
        const remote = await this.bot.getFile(item.fileID)
        const bytes = await this.bot.downloadFile(remote)
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(`download exceeded ${formatBytes(MAX_IMAGE_BYTES)}`)
        }
        const saved = await saveImage(bytes, item.name)
        files.push({ uri: toFileUri(saved), name: item.name })
      } catch (error) {
        errors.push(describeError(error))
      }
    }
    return { files, errors }
  }

  /**
   * Unique, filesystem-safe name for an inbound document. The message ID keeps
   * two uploads of the same filename from clobbering each other on disk —
   * sessions keep the `file://` URI, so a swapped file would show the model
   * the wrong picture on later reads.
   */
  private documentFilename(message: TelegramMessage, doc: TelegramDocument): string {
    const raw = (doc.file_name ?? "").split(/[\\/]/).pop() ?? ""
    const safe = raw
      .replace(/[\x00-\x1f<>:"|?*]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 100)
    const base = safe !== "" ? safe : "image"
    const name = `telegram-${message.message_id}-${base}`
    // Mime-derived extension when the original name has none (mime detection
    // is content-based; the suffix only keeps previews working).
    return /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}${extensionFor(doc.mime_type)}`
  }

  /** A message typed while a question is open answers it instead of prompting. */
  private async consumeAnswerText(chatID: number, text: string): Promise<boolean> {
    for (const wait of [...this.questions.values()]) {
      if (wait.chatID !== chatID || wait.settled) continue
      const index = wait.freeText ?? wait.answers.findIndex((answer) => answer === null)
      if (index < 0 || index >= wait.questions.length) continue
      await this.setQuestionAnswer(wait, index, [text])
      return true
    }
    return false
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionID) return this.sessionID
    const created = await this.ctx.session.create({ title: "Telegram" })
    this.sessionID = created.id
    this.trackedCache.clear()
    await this.ctx.storage.set("session", created.id)
    return created.id
  }

  private async sendToSession(
    chatID: number,
    text: string,
    files?: ReadonlyArray<{ uri: string; name: string }>,
  ): Promise<void> {
    let sessionID: string
    try {
      sessionID = await this.ensureSession()
    } catch (error) {
      await this.safeSendTo(chatID, `Could not create a session: ${describeError(error)}`)
      return
    }
    try {
      await this.ctx.session.prompt({
        sessionID,
        text,
        ...(files && files.length > 0 ? { files: files.map((file) => ({ uri: file.uri, name: file.name })) } : {}),
        delivery: this.options.delivery,
      })
    } catch (error) {
      await this.safeSendTo(chatID, `Could not queue the message: ${describeError(error)}`)
    }
  }

  /**
   * Entry point for the `send_telegram_image` tool: push a picture — an
   * existing file or a fresh screen capture — into the primary Telegram chat.
   *
   * The chat is resolved from bridge state, never from tool input: the agent
   * must not be able to aim images at arbitrary chats.
   */
  async sendImageToUser(input: { path?: string; capture?: boolean; caption?: string }): Promise<string> {
    const chatID = this.primaryChatId()
    if (chatID === undefined) {
      throw new Error(
        "No Telegram chat has contacted the bridge yet — the user must message the bot once before pictures can be sent.",
      )
    }
    const capture = input.capture === true
    const source = typeof input.path === "string" ? input.path.trim() : ""
    if (!capture && source === "") {
      throw new Error("Provide `path` (an existing image file) or `capture: true` (screenshot the screen).")
    }
    const shot = capture ? await captureScreen() : await readImageFile(source)
    const caption = typeof input.caption === "string" ? input.caption.trim().slice(0, 1024) : ""
    await this.bot.sendPhoto(chatID, shot.bytes, shot.filename, caption || undefined)
    return `Sent ${shot.filename} (${formatBytes(shot.bytes.byteLength)}) to Telegram${
      caption ? ` with caption "${caption}"` : ""
    }.`
  }

  private async handleCommand(chatID: number, text: string): Promise<void> {
    const parts = text.split(/\s+/)
    const command = (parts[0] ?? "").split("@")[0]?.toLowerCase() ?? ""
    const argument = parts[1]

    switch (command) {
      case "/start":
      case "/help":
        await this.safeSendTo(chatID, HELP)
        return

      case "/new": {
        try {
          const created = await this.ctx.session.create({ title: `Telegram ${stamp()}` })
          this.sessionID = created.id
          this.trackedCache.clear()
          await this.ctx.storage.set("session", created.id)
          for (const wait of [...this.questions.values()]) this.settleQuestion(wait, "cancelled")
          await this.safeSendTo(chatID, `🆕 New session started.\n\nSession: ${created.id}`)
        } catch (error) {
          await this.safeSendTo(chatID, `Could not start a session: ${describeError(error)}`)
        }
        return
      }

      case "/session": {
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet — send me a message first.")
          return
        }
        const info = await this.ctx.session.get({ sessionID: this.sessionID }).catch(() => undefined)
        const lines = [`Session: ${this.sessionID}`]
        if (info?.title) lines.push(`Title: ${info.title}`)
        if (info?.agent) lines.push(`Agent: ${info.agent}`)
        if (info?.model) lines.push(`Model: ${info.model.providerID}/${info.model.id}`)
        lines.push(`Project: ${String(this.ctx.location.directory)}`)
        await this.safeSendTo(chatID, lines.join("\n"))
        return
      }

      case "/sessions": {
        const sessions = await this.machineSessions()
        if (sessions.length === 0) {
          await this.safeSendTo(chatID, "No sessions found on this machine.")
          return
        }
        const bound = this.sessionID
        const lines = [`📋 Sessions on this machine (${sessions.length}):`, ""]
        for (const [index, session] of sessions.slice(0, 40).entries()) {
          const marker = session.id === bound ? "▶" : " "
          const tag = [projectLabel(session.directory), relative(session.updated)].filter(Boolean).join(" · ")
          lines.push(`${marker} ${index + 1}. ${fitMessage(session.title ?? "(untitled)", 60)}${tag ? `  [${tag}]` : ""}`)
        }
        if (sessions.length > 40) lines.push(`… and ${sessions.length - 40} more`)
        lines.push("", bound ? "▶ = bound session. Rebind with /switch <n>." : "Send a message to bind, or /switch <n> to pick one.")
        await this.safeSendTo(chatID, lines.join("\n"))
        return
      }

      case "/switch": {
        const sessions = await this.machineSessions()
        const n = Number.parseInt(argument ?? "", 10)
        if (!Number.isFinite(n) || n < 1 || n > sessions.length) {
          await this.safeSendTo(
            chatID,
            sessions.length === 0
              ? "No sessions found on this machine."
              : `Pick 1–${sessions.length}. Run /sessions to see the list.`,
          )
          return
        }
        const target = sessions[n - 1]
        this.sessionID = target.id
        this.trackedCache.clear()
        await this.ctx.storage.set("session", target.id)
        for (const wait of [...this.questions.values()]) this.settleQuestion(wait, "cancelled")
        const lines = [`🔁 Bound to session #${n}:`, target.title ?? target.id]
        if (target.directory && target.directory !== String(this.ctx.location.directory)) {
          lines.push("", `⚠️ It lives in ${target.directory} (the bridge is rooted at ${String(this.ctx.location.directory)}), so its live output may not stream here.`)
        }
        await this.safeSendTo(chatID, lines.join("\n"))
        return
      }

      case "/models": {
        const query = parts.slice(1).join(" ").trim().toLowerCase()
        let models: Array<Record<string, unknown>> = []
        try {
          const raw = await this.ctx.model.list({ location: { directory: String(this.ctx.location.directory) } })
          models = this.unwrapList(raw, "model.list")
        } catch (error) {
          await this.safeSendTo(chatID, `Could not list models: ${describeError(error)}`)
          return
        }
        let filtered = models.filter((model) => model.enabled !== false)
        if (query) {
          filtered = filtered.filter((model) =>
            `${model.providerID ?? ""} ${model.id ?? ""} ${model.name ?? ""}`.toLowerCase().includes(query),
          )
        }
        const cap = 30
        const shown = filtered.slice(0, cap)
        if (shown.length === 0) {
          await this.safeSendTo(chatID, `No models match${query ? ` "${query}"` : ""}. Try /models <text> to search.`)
          return
        }
        this.modelChoices = shown.map((model) => ({
          providerID: String(model.providerID),
          id: String(model.id),
          name: typeof model.name === "string" ? model.name : undefined,
          variant: typeof model.variant === "string" ? model.variant : undefined,
        }))
        const current = await this.currentModelKey()
        const lines = [
          `🧩 Models${query ? ` matching "${query}"` : ""} (${shown.length}${filtered.length > cap ? ` of ${filtered.length}` : ""}):`,
          "",
        ]
        for (const [index, model] of shown.entries()) {
          const key = `${String(model.providerID)}/${String(model.id)}`
          const label = typeof model.name === "string" && model.name !== model.id ? `${key} — ${model.name}` : key
          lines.push(`${index + 1}. ${label}${current === key ? "  ▶" : ""}`)
        }
        if (filtered.length > cap) lines.push("", `… ${filtered.length - cap} more. Search with /models <text>.`)
        lines.push("", "Switch with /model <n> or /model <provider>/<id>.")
        await this.safeSendTo(chatID, fitMessage(lines.join("\n")))
        return
      }

      case "/model": {
        const target = parts.slice(1).join(" ").trim()
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet — send a message first.")
          return
        }
        if (target === "") {
          const info = await this.ctx.session.get({ sessionID: this.sessionID }).catch(() => undefined)
          const model = info?.model
          await this.safeSendTo(chatID, model ? `Current model: ${model.providerID}/${model.id}` : "Current model: unknown.")
          return
        }
        let resolved: { providerID: string; id: string; variant?: string } | undefined
        const n = Number.parseInt(target, 10)
        if (Number.isFinite(n) && n >= 1 && n <= this.modelChoices.length) {
          resolved = this.modelChoices[n - 1]
        } else if (target.includes("/")) {
          const cut = target.indexOf("/")
          resolved = { providerID: target.slice(0, cut), id: target.slice(cut + 1) }
        }
        if (!resolved) {
          await this.safeSendTo(chatID, `Could not resolve model "${target}". Run /models first, or use /model <provider>/<id>.`)
          return
        }
        const model: { providerID: string; id: string; variant?: string } = { providerID: resolved.providerID, id: resolved.id }
        if (resolved.variant) model.variant = resolved.variant
        try {
          await this.ctx.session.switchModel({ sessionID: this.sessionID, model })
          await this.safeSendTo(chatID, `🧩 Model set to ${resolved.providerID}/${resolved.id}.`)
        } catch (error) {
          await this.safeSendTo(chatID, `Could not switch model: ${describeError(error)}`)
        }
        return
      }

      case "/agents": {
        let agents: Array<Record<string, unknown>> = []
        try {
          const raw = await this.ctx.agent.list({ location: { directory: String(this.ctx.location.directory) } })
          agents = this.unwrapList(raw, "agent.list")
        } catch (error) {
          await this.safeSendTo(chatID, `Could not list agents: ${describeError(error)}`)
          return
        }
        const lines = [`🤖 Agents (${agents.length}):`, ""]
        for (const [index, agent] of agents.entries()) {
          const id = String(agent.id)
          const name = typeof agent.name === "string" ? agent.name : undefined
          lines.push(`${index + 1}. ${id}${name && name !== id ? ` — ${name}` : ""} (${String(agent.mode ?? "?")})`)
        }
        lines.push("", "Switch with /agent <n> or /agent <name>.")
        await this.safeSendTo(chatID, fitMessage(lines.join("\n")))
        return
      }

      case "/agent": {
        const target = parts.slice(1).join(" ").trim().toLowerCase()
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet — send a message first.")
          return
        }
        if (target === "") {
          const info = await this.ctx.session.get({ sessionID: this.sessionID }).catch(() => undefined)
          await this.safeSendTo(chatID, `Current agent: ${info?.agent ?? "unknown"}.`)
          return
        }
        let agents: Array<Record<string, unknown>> = []
        try {
          const raw = await this.ctx.agent.list({ location: { directory: String(this.ctx.location.directory) } })
          agents = this.unwrapList(raw, "agent.list")
        } catch (error) {
          await this.safeSendTo(chatID, `Could not list agents: ${describeError(error)}`)
          return
        }
        let agentID: string | undefined
        const n = Number.parseInt(target, 10)
        if (Number.isFinite(n) && n >= 1 && n <= agents.length) {
          agentID = String(agents[n - 1].id)
        } else if (agents.some((agent) => String(agent.id).toLowerCase() === target)) {
          agentID = target
        }
        if (!agentID) {
          await this.safeSendTo(chatID, `No agent matches "${target}". Run /agents to see the list.`)
          return
        }
        try {
          await this.ctx.session.switchAgent({ sessionID: this.sessionID, agent: agentID })
          await this.safeSendTo(chatID, `🤖 Agent set to ${agentID}.`)
        } catch (error) {
          await this.safeSendTo(chatID, `Could not switch agent: ${describeError(error)}`)
        }
        return
      }

      case "/rename": {
        const title = parts.slice(1).join(" ").trim()
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet — send a message first.")
          return
        }
        if (title === "") {
          await this.safeSendTo(chatID, "Usage: /rename <new title>")
          return
        }
        try {
          await this.ctx.session.update({ sessionID: this.sessionID, title })
          await this.safeSendTo(chatID, `✏️ Renamed to "${title}".`)
        } catch (error) {
          await this.safeSendTo(chatID, `Could not rename: ${describeError(error)}`)
        }
        return
      }

      case "/compact": {
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet — send a message first.")
          return
        }
        try {
          await this.ctx.session.compact({ sessionID: this.sessionID })
          await this.safeSendTo(chatID, "🧹 Compaction requested — it will run at the next step boundary.")
        } catch (error) {
          await this.safeSendTo(chatID, `Could not compact: ${describeError(error)}`)
        }
        return
      }

      case "/delete": {
        const sessions = await this.machineSessions()
        const n = Number.parseInt(argument ?? "", 10)
        if (!Number.isFinite(n) || n < 1 || n > sessions.length) {
          await this.safeSendTo(
            chatID,
            sessions.length === 0
              ? "No sessions found on this machine."
              : `Pick 1–${sessions.length}. Run /sessions to see the list.`,
          )
          return
        }
        const target = sessions[n - 1]
        const title = target.title ?? target.id
        this.pendingDeletes.set(target.id, { title })
        await this.safeSendTo(
          chatID,
          `🗑 Delete session #${n}?\n\n${title}\n\nThis removes the session and its subagents. It cannot be undone.`,
          {
            inline_keyboard: [
              [
                { text: "🗑 Delete", callback_data: `d:${target.id}:y` },
                { text: "❌ Cancel", callback_data: `d:${target.id}:n` },
              ],
            ],
          },
        )
        return
      }

      case "/status": {
        const lines = [`Project: ${String(this.ctx.location.directory)}`]
        if (this.sessionID) {
          const info = await this.ctx.session.get({ sessionID: this.sessionID }).catch(() => undefined)
          lines.push(`Bound session: ${this.sessionID}${info?.title ? ` (${info.title})` : ""}`)
          if (info?.agent) lines.push(`Agent: ${info.agent}`)
          if (info?.model) lines.push(`Model: ${info.model.providerID}/${info.model.id}`)
        } else {
          lines.push("Bound session: none yet")
        }
        if (this.options.allSessionPermissions) {
          const entries = await this.pendingPermissionEntries()
          const requests = entries.flatMap((entry) => entry.requests)
          lines.push("", `Pending permissions (every session): ${requests.length}`)
          let index = 0
          for (const entry of entries) {
            for (const request of entry.requests) {
              index++
              if (index > 20) break
              lines.push(`${index}. [${entry.title}] ${request.action}: ${request.resources.slice(0, 2).join(", ")}`)
            }
            if (index > 20) break
          }
          if (requests.length > 20) lines.push(`… and ${requests.length - 20} more`)
          if (requests.length > 0) lines.push("", "Approve with /allow [n], reject with /deny [n].")
        } else if (this.sessionID) {
          try {
            const pending = this.unwrapList(
              await this.ctx.permission.list({ sessionID: this.sessionID }),
              "permission.list",
            )
            lines.push("", `Pending permissions: ${pending.length}`)
            pending.forEach((request, index) => {
              lines.push(`${index + 1}. ${request.action}: ${request.resources.slice(0, 3).join(", ")}`)
            })
            if (pending.length > 0) lines.push("", "Approve with /allow [n], reject with /deny [n].")
          } catch {
            lines.push("", "Pending permissions: unknown")
          }
        }
        const open = [...this.questions.values()].filter((wait) => !wait.settled).length
        if (open > 0) lines.push(`Open questions: ${open}`)
        await this.safeSendTo(chatID, lines.join("\n"))
        return
      }

      case "/tokens": {
        void this.bot.sendChatAction(chatID, "typing").catch(() => undefined)
        let report: TokenUsageReport
        let count: (value: number) => string
        let usd: (value: number) => string
        try {
          // Load token-usage's own contract and formatters: Bun's module cache hands
          // back the identical `TokenUsage` object the server registered with, so the
          // schema cannot drift, and a missing plugin fails only this command.
          const [contract, format] = await Promise.all([
            import("../../.config/opencode/plugins/token-usage/rpc.ts"),
            import("../../.config/opencode/plugins/token-usage/format.ts"),
          ])
          report = (await this.ctx.rpc(contract.TokenUsage).report({})) as TokenUsageReport
          count = format.count
          usd = format.usd
        } catch (error) {
          await this.safeSendTo(
            chatID,
            [
              "⚠️ Token usage unavailable.",
              "",
              describeError(error),
              "",
              "/tokens needs the token-usage plugin at",
              "~/.config/opencode/plugins/token-usage",
            ].join("\n"),
          )
          return
        }
        // One window per line: Telegram renders plain text in a proportional font,
        // so a space-padded table would come out ragged.
        const windows = report.windows ?? []
        if (windows.length === 0) {
          await this.safeSendTo(chatID, "📊 Token usage: nothing recorded yet — totals fill in as model calls run.")
          return
        }
        const lines = ["📊 Token usage", ""]
        for (const window of windows) {
          const label = window.label ? String(window.label) : String(window.id)
          lines.push(
            `${label} — ${count(Number(window.total))} (${count(Number(window.input))} in / ${count(
              Number(window.output),
            )} out) · ${usd(Number(window.cost))}`,
          )
        }
        const lifetime = windows.find((window) => String(window.id) === "lifetime")
        const hour = windows.find((window) => String(window.id) === "1h")
        if (lifetime !== undefined) {
          const recent = hour !== undefined ? ` · ${count(Number(hour.calls))} in the last hour` : ""
          lines.push(
            "",
            `lifetime: ${count(Number(lifetime.calls))} model calls${recent}`,
            `reasoning ${count(Number(lifetime.reasoning))} · cache ${count(Number(lifetime.cacheRead))} read / ${count(
              Number(lifetime.cacheWrite),
            )} write`,
          )
        }
        if (Number(report.since) > 0) {
          const date = new Date(Number(report.since)).toISOString().slice(0, 10)
          lines.push(`tracked since ${date}${report.seeded ? " · lifetime includes pre-install usage" : ""}`)
        }
        lines.push(`hourly detail kept ${Number(report.retentionDays)} days · lifetime totals never expire`)
        await this.safeSendTo(chatID, fitMessage(lines.join("\n")))
        return
      }

      case "/allow":
      case "/deny":
        await this.handlePermissionCommand(chatID, command === "/allow" ? "once" : "reject", argument)
        return

      case "/cancel": {
        if (!this.sessionID) {
          await this.safeSendTo(chatID, "No session is bound yet.")
          return
        }
        try {
          await this.ctx.session.interrupt({ sessionID: this.sessionID })
          await this.safeSendTo(chatID, "⏹ Interrupted.")
        } catch (error) {
          await this.safeSendTo(chatID, `Could not interrupt: ${describeError(error)}`)
        }
        return
      }

      default:
        await this.safeSendTo(chatID, `Unknown command ${command}. Try /help.`)
    }
  }

  private async handlePermissionCommand(
    chatID: number,
    decision: "once" | "reject",
    argument: string | undefined,
  ): Promise<void> {
    const requests = await this.pendingPermissionRequests()
    if (requests.length === 0) {
      await this.safeSendTo(
        chatID,
        this.sessionID || this.options.allSessionPermissions
          ? "No pending permission requests."
          : "No session is bound yet.",
      )
      return
    }
    const requested = Number.parseInt(argument ?? "1", 10)
    const index = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), requests.length) - 1 : 0
    const request = requests[index]
    if (!request) {
      await this.safeSendTo(chatID, `Only ${requests.length} pending request(s).`)
      return
    }
    try {
      await this.replyPermission(request.sessionID, request.id, decision)
    } catch (error) {
      await this.safeSendTo(chatID, `Could not reply: ${describeError(error)}`)
      return
    }
    const label = decision === "once" ? "✅ Allowed once (via command)" : "❌ Rejected (via command)"
    await this.closePermissionCard(request.id, label)
    await this.safeSendTo(chatID, `${label}\n\n${this.renderPermission(request)}`)
  }

  /** `providerID/id` for the bound session's current model, if any. */
  private async currentModelKey(): Promise<string | undefined> {
    if (!this.sessionID) return undefined
    const info = await this.ctx.session.get({ sessionID: this.sessionID }).catch(() => undefined)
    const model = info?.model
    return model ? `${model.providerID}/${model.id}` : undefined
  }

  /**
   * Plugin list methods (`model.list`, `agent.list`, …) return `{ data: [...] }`
   * rather than a bare array — unwrap that, but tolerate a raw array too.
   */
  private unwrapList(raw: unknown, label: string): Array<Record<string, unknown>> {
    const data = (raw as { data?: unknown } | null | undefined)?.data ?? raw
    if (!Array.isArray(data)) throw new Error(`unexpected ${label} result (${data === null ? "null" : typeof data})`)
    return data as Array<Record<string, unknown>>
  }
}

// -------------------------------------------------------------------- helpers

function repliedLabel(reply: unknown): string {
  if (reply === "once") return "✅ Allowed once (answered elsewhere)"
  if (reply === "always") return "♻️ Allowed and saved (answered elsewhere)"
  if (reply === "reject") return "❌ Rejected (answered elsewhere)"
  return "Answered in another client"
}

function streamKey(data: Record<string, any>): string {
  return `${data.sessionID}::${data.assistantMessageID}::${data.ordinal ?? 0}`
}

function stamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** Short project label from a directory path, e.g. `/home/me/proj` → `proj`. */
function projectLabel(directory?: string): string | undefined {
  if (!directory) return undefined
  const trimmed = directory.replace(/\/+$/, "")
  return trimmed.split("/").filter(Boolean).pop() || trimmed
}

/** Coarse "2h ago" style age for a session's last-updated timestamp (ms). */
function relative(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ""
  const diff = Date.now() - ms
  if (diff < 60_000) return "just now"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ms).toLocaleDateString()
}
