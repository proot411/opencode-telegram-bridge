/**
 * Minimal Telegram Bot API client.
 *
 * Only `fetch` is used (OpenCode provides no npm installs for local plugins),
 * and everything is serialized through a small write queue so bursts of edits
 * stay inside Telegram's rate limits. Transient `429`/network failures are
 * retried with backoff; benign "nothing changed" edit errors are swallowed.
 */

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][]
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  chat: { id: number; type: string; title?: string }
  date?: number
  text?: string
  /** Caption of a photo/document message — Telegram puts it here instead of `text`. */
  caption?: string
  /** Photo sizes, smallest first; the last entry is the largest and the one to fetch. */
  photo?: TelegramPhotoSize[]
  /** Non-photo attachments; images sent "as file" arrive here. */
  document?: TelegramDocument
}

export interface TelegramCallbackQuery {
  id: string
  from?: { id: number }
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export class TelegramError extends Error {
  readonly code?: number
  readonly retryAfter?: number
  readonly description?: string

  constructor(message: string, init?: { code?: number; retryAfter?: number; description?: string }) {
    super(message)
    this.name = "TelegramError"
    this.code = init?.code
    this.retryAfter = init?.retryAfter
    this.description = init?.description
  }

  /** Edits that did not change anything, and edits of expired messages, are not failures. */
  get benign(): boolean {
    const detail = `${this.description ?? ""} ${this.message ?? ""}`.toLowerCase()
    return (
      detail.includes("message is not modified") ||
      detail.includes("message to edit not found") ||
      detail.includes("message can't be edited") ||
      detail.includes("message to edit not found") ||
      detail.includes("query is too old")
    )
  }
}

export function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || error.name === "TimeoutError"
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split a message into chunks Telegram accepts (4096 characters maximum). */
export function splitMessage(text: string, limit = 4096): string[] {
  const source = text.length > 0 ? text : " "
  const chunks: string[] = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  chunks.push(rest)
  return chunks
}

/** Keep a single message inside Telegram's limit while it is being edited live. */
export function fitMessage(text: string, limit = 4096): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}

/**
 * Hard deadline for one outbound API call (retries included). Without it a hung
 * socket blocks whatever awaits the call — which is the poll loop (via
 * `handleUpdate`) and `stop()` (via its flush), i.e. the whole bridge.
 */
const WRITE_TIMEOUT_MS = 20_000

interface ApiResult<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export class TelegramBot {
  private chain: Promise<unknown> = Promise.resolve()
  private lastWrite = 0

  constructor(
    readonly token: string,
    readonly apiBase: string,
  ) {}

  private get base(): string {
    return `${this.apiBase.replace(/\/+$/, "")}/bot${this.token}`
  }

  /**
   * Low level request; retries rate limits and transient network errors.
   *
   * `timeoutMs`, when given, bounds the entire call (retries included) so a hung
   * socket can never wedge the caller. `getUpdates` omits it and relies on its
   * own long-poll watchdog instead.
   */
  private async request<T>(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    const watchdog = timeoutMs !== undefined ? new AbortController() : undefined
    const timer = timeoutMs !== undefined ? setTimeout(() => watchdog?.abort(), timeoutMs) : undefined
    const forward = () => watchdog?.abort()
    if (watchdog && signal) {
      if (signal.aborted) watchdog.abort()
      else signal.addEventListener("abort", forward, { once: true })
    }
    const active = watchdog ? watchdog.signal : signal
    const form = body instanceof FormData
    try {
      let lastError: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        if (active?.aborted) throw new DOMException("Aborted", "AbortError")
        try {
          const response = await fetch(`${this.base}/${method}`, {
            method: "POST",
            // FormData must carry its own multipart boundary — any explicit
            // content-type header (JSON or otherwise) would corrupt it.
            ...(form ? {} : { headers: { "content-type": "application/json" } }),
            body: form ? body : JSON.stringify(body),
            signal: active,
          })
          const payload = (await response.json().catch(() => undefined)) as ApiResult<T> | undefined
          if (payload?.ok) return payload.result as T
          const error = new TelegramError(payload?.description ?? `Telegram HTTP ${response.status}`, {
            code: payload?.error_code ?? response.status,
            retryAfter: payload?.parameters?.retry_after,
            description: payload?.description,
          })
          if (error.code === 429 && typeof error.retryAfter === "number" && attempt < 3) {
            await delay(Math.min(30, Math.max(1, error.retryAfter)) * 1000)
            continue
          }
          throw error
        } catch (error) {
          if (isAbort(error)) throw error
          if (error instanceof TelegramError) throw error
          lastError = error
          if (attempt < 3) {
            await delay(400 * (attempt + 1))
            continue
          }
        }
      }
      throw new TelegramError(`Telegram request failed: ${describeError(lastError)}`)
    } finally {
      clearTimeout(timer)
      if (watchdog && signal) signal.removeEventListener("abort", forward)
    }
  }

  /**
   * Writes are serialized and spaced so a burst of messages/edits does not trip
   * Telegram's per-second limits. Reads (long polling) deliberately bypass it.
   */
  private write<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    const task = async (): Promise<T> => {
      const wait = this.lastWrite + 60 - Date.now()
      if (wait > 0) await delay(wait)
      this.lastWrite = Date.now()
      return this.request<T>(method, body, signal, WRITE_TIMEOUT_MS)
    }
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  getMe(signal?: AbortSignal) {
    return this.request<{ id: number; username: string; first_name: string }>("getMe", {}, signal)
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal, limit = 100) {
    // The client-side deadline has to outlive the server-side long poll.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (timeoutSec + 20) * 1000)
    const forward = () => controller.abort()
    signal?.addEventListener("abort", forward, { once: true })
    const done = <T>(value: T): T => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
      return value
    }
    const failed = (error: unknown): TelegramUpdate[] => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
      // Our own deadline fired while the caller is still alive: report an empty
      // batch instead of an error, so the poll loop keeps running.
      if (controller.signal.aborted && !signal?.aborted) return []
      throw error
    }
    return this.request<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, limit, allowed_updates: ["message", "callback_query"] },
      controller.signal,
    ).then(done, failed)
  }

  sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: InlineKeyboard; disableNotification?: boolean },
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    return this.write<TelegramMessage>(
      "sendMessage",
      {
        chat_id: chatId,
        text: fitMessage(text),
        ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        ...(options?.disableNotification ? { disable_notification: true } : {}),
      },
      signal,
    )
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: { replyMarkup?: InlineKeyboard },
    signal?: AbortSignal,
  ): Promise<TelegramMessage | true> {
    return this.write<TelegramMessage | true>(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text: fitMessage(text),
        reply_markup: options?.replyMarkup ?? { inline_keyboard: [] },
      },
      signal,
    )
  }

  answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<true> {
    return this.request<true>(
      "answerCallbackQuery",
      {
        callback_query_id: id,
        ...(text ? { text: fitMessage(text, 200), show_alert: showAlert } : {}),
      },
      undefined,
      WRITE_TIMEOUT_MS,
    )
  }

  sendChatAction(chatId: number, action: "typing"): Promise<true> {
    return this.request<true>("sendChatAction", { chat_id: chatId, action }, undefined, WRITE_TIMEOUT_MS)
  }

  /**
   * Upload a picture to a chat as multipart/form-data. The caption is plain
   * text (the bridge never sends parse_mode) and is capped at Telegram's
   * 1024-character limit. Bytes are buffered in memory, which matches the
   * 10MB photo ceiling anyway.
   */
  sendPhoto(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    caption?: string,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    const form = new FormData()
    form.append("chat_id", String(chatId))
    form.append("photo", new Blob([bytes], { type: mimeForFilename(filename) }), filename)
    const trimmed = caption?.trim()
    if (trimmed) form.append("caption", trimmed.slice(0, 1024))
    return this.write<TelegramMessage>("sendPhoto", form, signal)
  }

  /** Resolve a `file_id` to the relative path used by {@link downloadFile}. */
  async getFile(fileId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ file_path?: string }>("getFile", { file_id: fileId }, signal, WRITE_TIMEOUT_MS)
    const filePath = result.file_path
    if (typeof filePath !== "string" || filePath === "") {
      throw new TelegramError("Telegram getFile returned no file_path (file expired or too old?)")
    }
    return filePath
  }

  /**
   * Download a file resolved with {@link getFile}. The endpoint is a plain GET
   * with no server-side timeout, so a local watchdog bounds it; transient
   * network failures and 429s retry, everything else fails fast.
   */
  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = `${this.apiBase.replace(/\/+$/, "")}/file/bot${this.token}/${filePath}`
    const watchdog = new AbortController()
    const timer = setTimeout(() => watchdog.abort(), 60_000)
    const forward = () => watchdog.abort()
    if (signal) {
      if (signal.aborted) watchdog.abort()
      else signal.addEventListener("abort", forward, { once: true })
    }
    try {
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        if (watchdog.signal.aborted) throw new DOMException("Aborted", "AbortError")
        try {
          const response = await fetch(url, { method: "GET", signal: watchdog.signal })
          if (!response.ok) {
            const error = new TelegramError(`Telegram file download failed: HTTP ${response.status}`, {
              code: response.status,
            })
            if (error.code === 429 && attempt < 2) {
              await delay(1_000)
              continue
            }
            throw error
          }
          return new Uint8Array(await response.arrayBuffer())
        } catch (error) {
          if (isAbort(error)) throw error
          if (error instanceof TelegramError) throw error
          lastError = error
          if (attempt < 2) {
            await delay(500 * (attempt + 1))
            continue
          }
        }
      }
      throw new TelegramError(`Telegram file download failed: ${describeError(lastError)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
    }
  }

  setMyCommands(commands: ReadonlyArray<{ command: string; description: string }>): Promise<true> {
    return this.write<true>("setMyCommands", { commands: [...commands] })
  }
}

/** Content type for an uploaded picture; Telegram re-encodes anyway, but correct types keep previews happy. */
function mimeForFilename(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase()
  switch (ext) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    case "bmp":
      return "image/bmp"
    default:
      return "image/jpeg"
  }
}
