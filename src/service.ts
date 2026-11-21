import { OpenCode } from "@opencode/client/promise";

/**
 * Connection to the OpenCode server that hosts THIS plugin process.
 *
 * A `serve` process advertises itself in `~/.local/state/opencode/service.json`
 * (url + pid + password — written by the server, read by every local client).
 * The plugin runs inside that same server, so the registration is the one
 * honest source for "how do I call back into OpenCode?": the pid check binds
 * the URL to this exact process, and the password is the Basic-auth credential
 * the server itself generated.
 *
 * What it buys the bridge: `session.form.reply` / `session.form.cancel`. The
 * built-in `question` tool creates an OpenCode Form and blocks on it; the TUI
 * renders that form as the interactive poll. Replying over HTTP settles the
 * form from either side — Telegram and the TUI become two answer channels for
 * one poll, first answer wins.
 *
 * Returns undefined when the registration is missing, foreign (pid mismatch —
 * another server owns that URL and its form cache), or unreachable. Callers
 * fall back to Telegram-only behavior.
 */
export type FormClient = ReturnType<typeof OpenCode.make>;

interface ServiceRegistration {
  url?: unknown;
  pid?: unknown;
  password?: unknown;
}

// The typecheck config deliberately has no @types/node (see media.ts); the
// options reader touches `process` through this same globalThis cast.
const host = globalThis as {
  process?: {
    pid?: number;
    platform?: string;
    env?: Record<string, string | undefined>;
  };
};

function stateHome(): string | undefined {
  const env = host.process?.env ?? {};
  if (typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME !== "") return env.XDG_STATE_HOME;
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof home !== "string" || home === "") return undefined;
  const sep = host.process?.platform === "win32" ? "\\" : "/";
  return `${home}${sep}.local${sep}state`;
}

export async function connectService(timeoutMs = 3_000): Promise<FormClient | undefined> {
  try {
    const base = stateHome();
    if (base === undefined || host.process?.pid === undefined) return undefined;
    const sep = host.process.platform === "win32" ? "\\" : "/";
    const path = `${base}${sep}opencode${sep}service.json`;

    // node:fs at runtime; the missing @types/node is the same pre-existing
    // trade-off media.ts makes (typecheck gate: no new errors).
    // @ts-ignore
    const { readFile } = await import("node:fs/promises");
    const info = JSON.parse(await readFile(path, "utf8")) as ServiceRegistration;

    // Only talk to the server we ARE. A stale registration (dead pid) or a
    // neighbour process's URL would answer against the wrong form cache.
    if (typeof info.url !== "string" || info.pid !== host.process.pid) return undefined;

    const headers =
      typeof info.password === "string" && info.password !== ""
        ? { authorization: `Basic ${btoa(`opencode:${info.password}`)}` }
        : undefined;
    const client = OpenCode.make({ baseUrl: info.url, headers });

    // One cheap probe proves url, auth, and liveness in a single round trip.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await client.server.info({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    return client;
  } catch {
    return undefined;
  }
}
