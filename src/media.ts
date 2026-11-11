/**
 * Image plumbing for the bridge: where Telegram media lands on disk, cleanup of
 * stale downloads, reading files for upload, and screen capture for the
 * `send_telegram_image` tool.
 *
 * Plain Node/Bun modules only (`fs`, `path`, `child_process`) — the plugin runs
 * unsandboxed in the OpenCode process and must never need an npm install.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Downloads older than this are swept when the bridge starts. */
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Telegram's ceiling for bot file downloads; OpenCode's attachment limit is also 20MB. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Telegram photo uploads cap at 10MB (bigger files must travel as documents). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function mediaDirPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "telegram-bridge", "media")
}

export async function ensureMediaDir(): Promise<string> {
  const dir = mediaDirPath()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** `file://` URI for an absolute path — the exact form `prompt({files})` accepts. */
export function toFileUri(absPath: string): string {
  return pathToFileURL(absPath).href
}

/** Persist downloaded bytes under a unique name; returns the absolute path. */
export async function saveImage(bytes: Uint8Array, filename: string): Promise<string> {
  const dir = await ensureMediaDir()
  const target = path.join(dir, filename)
  await fs.writeFile(target, bytes)
  return target
}

/** Sweep media files older than {@link MEDIA_MAX_AGE_MS}; never throws. */
export async function pruneMedia(): Promise<void> {
  try {
    const entries = await fs.readdir(mediaDirPath())
    const cutoff = Date.now() - MEDIA_MAX_AGE_MS
    for (const entry of entries) {
      const full = path.join(mediaDirPath(), entry)
      const stat = await fs.stat(full).catch(() => undefined)
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => undefined)
    }
  } catch {
    // Directory missing (nothing downloaded yet) or unreadable — nothing to do.
  }
}

/**
 * Read an image from disk for upload. Friendly errors, because every message
 * thrown here lands in the model's tool result: missing file, oversized file.
 */
export async function readImageFile(file: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file
  const resolved = path.resolve(expanded)
  const stat = await fs.stat(resolved).catch(() => undefined)
  if (!stat?.isFile()) throw new Error(`No such image file: ${resolved}`)
  if (stat.size > MAX_PHOTO_BYTES) {
    throw new Error(
      `Image is too large for a Telegram photo (${formatBytes(stat.size)}, limit ${formatBytes(MAX_PHOTO_BYTES)}).`,
    )
  }
  const bytes = await fs.readFile(resolved)
  return { bytes: new Uint8Array(bytes), filename: path.basename(resolved) }
}

/** File extension for a mime type, so saved documents keep a sensible suffix. */
export function extensionFor(mime?: string): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return ".png"
    case "image/jpeg":
      return ".jpg"
    case "image/webp":
      return ".webp"
    case "image/gif":
      return ".gif"
    case "image/bmp":
      return ".bmp"
    case "image/heic":
      return ".heic"
    case "image/heif":
      return ".heif"
    case "image/avif":
      return ".avif"
    default:
      return ".img"
  }
}

/**
 * Screenshot candidates in preference order: quiet non-interactive X11 tools
 * first (this machine is X11/XFCE), then desktop-environment launchers, then
 * Wayland. Missing binaries fail instantly with ENOENT; a tool that opens a
 * dialog instead of writing the file is killed by the per-attempt timeout and
 * the next candidate runs.
 */
const SCREENSHOT_COMMANDS: ReadonlyArray<{ cmd: string; args: (out: string) => string[] }> = [
  { cmd: "scrot", args: (out) => [out] },
  { cmd: "maim", args: (out) => [out] },
  { cmd: "import", args: (out) => ["-window", "root", out] },
  { cmd: "xfce4-screenshooter", args: (out) => ["-f", out] },
  { cmd: "gnome-screenshot", args: (out) => ["-f", out] },
  { cmd: "spectacle", args: (out) => ["-b", "-n", "-o", out] },
  { cmd: "grim", args: (out) => [out] },
]

const CAPTURE_ATTEMPT_MS = 12_000
const CAPTURE_TOTAL_MS = 45_000

/**
 * Capture the primary screen into the media directory and return its bytes.
 * The result file stays on disk (pruned after a week) so the model can refer
 * back to the path it was shown.
 */
export async function captureScreen(): Promise<{ bytes: Uint8Array; filename: string }> {
  const dir = await ensureMediaDir()
  const filename = `screen-${Date.now()}.png`
  const out = path.join(dir, filename)
  const deadline = Date.now() + CAPTURE_TOTAL_MS
  const tried: string[] = []
  for (const { cmd, args } of SCREENSHOT_COMMANDS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    tried.push(cmd)
    try {
      await exec(cmd, args(out), {
        timeout: Math.min(CAPTURE_ATTEMPT_MS, remaining),
        maxBuffer: 4 * 1024 * 1024,
      })
      const bytes = await fs.readFile(out).catch(() => undefined)
      if (bytes && bytes.byteLength > 0) return { bytes: new Uint8Array(bytes), filename }
    } catch {
      // Missing binary, blocked dialog, or non-zero exit — fall through.
    }
    await fs.unlink(out).catch(() => undefined)
  }
  throw new Error(
    `No working screenshot tool found (tried: ${tried.join(", ")}). ` +
      "Install one of scrot/maim/xfce4-screenshooter/spectacle/gnome-screenshot/grim, " +
      "or pass path=<file> with an image you saved from your shell instead.",
  )
}
