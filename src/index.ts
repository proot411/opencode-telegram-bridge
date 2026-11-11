import { Plugin } from "@opencode/plugin";
import { Bridge } from "./bridge.js";
import { readOptions } from "./options.js";
import { TelegramBot } from "./telegram.js";
import { normalizeQuestions, toModelContent } from "./events.js";

/**
 * opencode-telegram-bridge
 *
 * Bridges OpenCode to a Telegram bot so you can:
 *  - approve/deny permission requests with inline buttons
 *  - answer agent `question` tool prompts (selects + free text)
 *  - read the agent's output live (streamed message edits)
 *  - steer/queue messages into the running session
 *
 * All Telegram traffic goes through plain `fetch` — no dependencies.
 *
 * Configure in opencode.json(c):
 * ```jsonc
 * {
 *   "plugins": [
 *     { "package": "/absolute/path/opencode-telegram-bridge", "options": { "chatIDs": ["123456789"] } }
 *   ]
 * }
 * ```
 */
const plugin = Plugin.define({
  id: "opencode-telegram-bridge",
  async setup(ctx) {
    const options = readOptions(ctx.options);

    if (!options.token) {
      console.warn(
        '[opencode-telegram-bridge] no bot token configured — set the "token" plugin option ' +
          "or the TELEGRAM_BOT_TOKEN environment variable. Bridge disabled.",
      );
      return;
    }

    const bot = new TelegramBot(options.token, options.apiBase);
    const bridge = new Bridge(ctx, options, bot);
    await bridge.start();

    // Route the built-in `question` tool to Telegram, bypassing OpenCode's form
    // UI. Built-in "pre" plugins (including the question tool) register before
    // config plugins, so the tool is present when this transform first runs;
    // the callback also re-resolves the id on every later registry rebuild.
    let patched = false;
    const registration = await ctx.tool.transform((editor) => {
      const question = editor.list().find((tool) => isQuestionTool(tool.id, tool.description));
      if (!question) return;
      patched = true;
      editor.update(question.id, (tool) => {
        tool.execute = async (input, context) => {
          const questions = normalizeQuestions(input);

          // Same permission gate as the built-in tool: deny rules and
          // permission.asked prompts (surfaced to Telegram by this plugin)
          // apply before any question is shown. Errors propagate as tool
          // failures, exactly like the built-in implementation.
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "question",
            resources: ["*"],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          });

          const answers = await bridge.askQuestions(context.sessionID, questions, context.signal);
          return {
            output: { answers },
            content: toModelContent(questions, answers),
            metadata: { answers },
          };
        };
      });
    });

    if (!patched) {
      console.warn(
        "[opencode-telegram-bridge] built-in question tool not found during setup — " +
          "questions fall back to OpenCode forms (a Telegram notice is still sent).",
      );
    }

    // Let the agent push pictures to Telegram (screenshots, charts, renders)
    // through `send_telegram_image`. The target chat is resolved inside the
    // tool from bridge state — never taken from tool input — so the agent
    // cannot aim images at arbitrary chats. `editor.add` upserts by effective
    // name, so transform re-runs on registry rebuilds stay idempotent; the
    // guard keeps a future API change from disabling the whole plugin (the
    // tool would simply go missing).
    let imageToolState = "pending";
    let imageTool: { dispose: () => Promise<void> } | undefined;
    const recordImageTool = (state: string) => {
      imageToolState = state;
      // Diagnostic side-channel: console output never reaches OpenCode's log,
      // but the kv store does — this records whether registration happened.
      // Written from the callback too, because some builds invoke transforms
      // on the next registry rebuild rather than during registration itself.
      void ctx.storage.set("imageTool", state);
    };
    if (options.imageSend) {
      imageTool = await ctx.tool.transform((editor) => {
        if (typeof editor.add !== "function") {
          recordImageTool("no-editor-add");
          return;
        }
        editor.add({
          name: "send_telegram_image",
          input: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Absolute path of an existing image file to send (png/jpg/webp/gif, up to 10MB). " +
                  "Create the file first if needed (shell, matplotlib, ImageMagick, ...).",
              },
              capture: {
                type: "boolean",
                description: "true to screenshot the user's screen instead of using path (capture wins over path).",
              },
              caption: {
                type: "string",
                description: "Optional plain-text caption shown under the photo (max 1024 characters).",
              },
            },
            additionalProperties: false,
          },
          description:
            "Send a picture to the user's private Telegram chat. Use it whenever the user should SEE something: " +
            "a screenshot of their computer, a chart or diagram of project status, a rendered preview, or any " +
            "image you produced. Provide `path` for an existing image file, or `capture: true` to take a " +
            "screenshot of their screen right now. Optional `caption` appears under the photo. " +
            "The picture goes only to the user's own chat.",
          execute: async (input: { path?: string; capture?: boolean; caption?: string }) => ({
            content: await bridge.sendImageToUser(input ?? {}),
          }),
        });
        recordImageTool(
          editor.list().some((tool) => tool.name === "send_telegram_image") ? "registered" : "missing-after-add",
        );
      });
      // If this build runs transforms eagerly, this records the real state; if
      // it defers them, "pending" stands until the callback fires on rebuild.
      if (imageToolState === "pending") await ctx.storage.set("imageTool", "pending");
    } else {
      await ctx.storage.set("imageTool", "disabled");
    }

    return async () => {
      await registration.dispose().catch(() => undefined);
      await imageTool?.dispose().catch(() => undefined);
      await bridge.stop();
    };
  },
});

function isQuestionTool(id: string, description: string): boolean {
  if (id === "question" || id.endsWith("_question") || id.endsWith(".question")) return true;
  return description.startsWith("Use this tool when you need to ask the user questions");
}

export default plugin;
