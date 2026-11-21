// Behavioral harness for the opencode-telegram-bridge.
//
// Compile the TypeScript first (the harness runs against plain JS):
//   npm run build:test
//   node test/harness.mjs        (exit 0 = pass)
//
// Override the compiled output directory with TB_DIST when needed.
import { Bridge } from "../test-dist/opencode-telegram-bridge/src/bridge.js";

const CHAT = 100;
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function eq(a, b, label) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  ok(left === right, `${label} (got ${left}, want ${right})`);
}

// ------------------------------------------------------------------ fakes

function makeBot() {
  const bot = {
    getUpdatesCalls: 0,
    sent: [], // {chatID, text, keyboard}
    edits: [], // {chatID, messageID, text, keyboard}
    answers: [], // {text, alert}
    nextMessageID: 500,
    async setMyCommands() {},
    async getUpdates(offset, timeoutSec, signal) {
      bot.getUpdatesCalls++;
      // Startup backlog probe (signal undefined) returns immediately; the
      // long poll blocks until the hub's controller aborts.
      if (!signal) return [];
      return new Promise((resolve) => {
        const onAbort = () => resolve([]);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    async sendMessage(chatID, text, options) {
      bot.sent.push({ chatID, text, keyboard: options?.replyMarkup });
      return { message_id: bot.nextMessageID++ };
    },
    async editMessageText(chatID, messageId, text, options) {
      bot.edits.push({ chatID, messageID: messageId, text, keyboard: options?.replyMarkup });
      return true;
    },
    async answerCallbackQuery(id, text, showAlert) {
      bot.answers.push({ text, alert: showAlert });
      return true;
    },
    async sendChatAction() {},
  };
  return bot;
}

function makeCtx(sessions = [], getMap = {}, seedKv = {}) {
  const kv = new Map(Object.entries(seedKv));
  return {
    location: { directory: "/test" },
    storage: {
      async get(key) {
        return kv.get(key);
      },
      async set(key, value) {
        kv.set(key, value);
      },
    },
    event: {
      subscribe({ signal }) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((_, reject) => {
                  const onAbort = () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                  };
                  if (signal?.aborted) onAbort();
                  else signal?.addEventListener("abort", onAbort, { once: true });
                }),
            };
          },
        };
      },
    },
    session: {
      async list() {
        return { data: sessions.map((id) => ({ id })) };
      },
      async get({ sessionID }) {
        const entry = getMap[sessionID];
        if (entry === "missing") {
          const error = new Error(`Session not found: ${sessionID}`);
          error._tag = "SessionNotFoundError";
          throw error;
        }
        return {
          parentID: entry?.parentID,
          location: { directory: entry?.directory ?? "/test" },
        };
      },
      async create() {
        return { id: "ses_fake" };
      },
      async remove() {},
    },
    permission: {
      async list() {
        return [];
      },
    },
  };
}

function makeOptions(token, overrides = {}) {
  return {
    token,
    apiBase: "https://api.telegram.org",
    chatIDs: new Set([String(CHAT)]),
    allowAllChats: false,
    revealChatID: false,
    announce: false,
    delivery: "queue",
    stream: false,
    streamIntervalMs: 50,
    toolNotifications: false,
    providerAlerts: true,
    typing: false,
    forwardAllSessions: false,
    allSessionPermissions: false,
    questionTimeoutMs: 5_000,
    pollTimeoutSec: 50,
    keepAlive: false,
    imageSend: false,
    imageReceive: false,
    ...overrides,
  };
}

function makeFormClient(behavior = {}) {
  const fc = {
    replies: [],
    cancels: [],
    gets: [],
    lists: [],
  };
  fc.session = {
    form: {
      async reply(input) {
        fc.replies.push(input);
        if (behavior.reply) return behavior.reply(input, fc);
      },
      async cancel(input) {
        fc.cancels.push(input);
      },
      async get(input) {
        fc.gets.push(input);
        if (behavior.get) return behavior.get(input);
        return { state: { status: "answered", answer: {} } };
      },
      async list(input) {
        fc.lists.push(input);
        return behavior.list ? behavior.list(input) : [];
      },
    },
  };
  return fc;
}

const BOUND = "ses_bound123";

async function makeBridge({ token, formClient, options = {}, bot = makeBot(), ctx = makeCtx() }) {
  const bridge = new Bridge(ctx, makeOptions(token, { sessionID: BOUND, ...options }), bot, formClient);
  await bridge.start();
  return { bridge, bot, ctx, formClient };
}

function teardown(...bridges) {
  return Promise.all(bridges.map((b) => b?.stop?.().catch(() => undefined)));
}

function keyboardOf(sent) {
  return sent?.keyboard?.inline_keyboard ?? [];
}

function callbackDataOf(sent) {
  return keyboardOf(sent)[0]?.[0]?.callback_data;
}

const QUESTION_FORM = {
  id: "frm_test0001",
  sessionID: BOUND,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Approach",
      description: "Which approach should we take?",
      type: "string",
      options: [
        { value: "Option A", label: "Option A", description: "the fast one" },
        { value: "Option B", label: "Option B" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "Tags",
      description: "Which tags apply?",
      type: "multiselect",
      options: [
        { value: "X", label: "X" },
        { value: "Y", label: "Y" },
      ],
      custom: true,
    },
  ],
};

// One question only: a single tap completes the form.
const SINGLE_FORM = {
  id: "frm_single01",
  sessionID: BOUND,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [QUESTION_FORM.fields[0]],
};

const MULTIFORM = {
  id: "frm_multi001",
  sessionID: BOUND,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [QUESTION_FORM.fields[1]],
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function presentDefaultForm(bridge) {
  await bridge.onEvent({ type: "form.created", data: { form: QUESTION_FORM } });
}

// ------------------------------------------------------------------ tests

async function testHubSharedSinglePoller() {
  console.log("hub: two bridges on one token share ONE poll loop");
  const botA = makeBot();
  const botB = makeBot();
  const a = await makeBridge({ token: "tok-hub", bot: botA });
  const b = await makeBridge({ token: "tok-hub", bot: botB });
  try {
    ok(botA.getUpdatesCalls >= 1, "first bridge's bot polls");
    ok(botB.getUpdatesCalls === 0, "second bridge's bot never polls (hub owns the loop)");
  } finally {
    await teardown(a.bridge, b.bridge);
  }
}

async function testCallbackRoutingAndStale() {
  console.log("hub: taps route to the owning card; foreign instances answer stale honestly");
  const a = await makeBridge({ token: "tok-route" });
  const b = await makeBridge({ token: "tok-route" });
  try {
    const done = a.bridge.askQuestions(BOUND, [{ question: "Pick one", options: [{ label: "Red" }, { label: "Blue" }] }]);
    await tick();
    const data = callbackDataOf(a.bot.sent.at(-1));
    ok(typeof data === "string" && data.startsWith("q:"), "question card carries a q: callback");
    ok((await a.bridge.wantsCallback(data, CHAT)) === true, "owner instance wants the tap");
    ok((await b.bridge.wantsCallback(data, CHAT)) === false, "other instance rejects the tap");
    await b.bridge.handleCallback({ id: "cb1", data, message: { chat: { id: CHAT } } });
    eq(b.bot.answers.at(-1)?.text, "This question has expired.", "foreign tap answered as expired");
    await a.bridge.handleCallback({ id: "cb2", data, message: { chat: { id: CHAT } } });
    const answers = await done;
    eq(answers, [["Red"]], "owner tap resolves the question");
  } finally {
    await teardown(a.bridge, b.bridge);
  }
}

async function testFreeTextExpectation() {
  console.log("hub: typed messages go to the instance waiting for an answer");
  const a = await makeBridge({ token: "tok-free-a" });
  const b = await makeBridge({ token: "tok-free-b" });
  try {
    const done = a.bridge.askQuestions(BOUND, [{ question: "Name it" }]);
    await tick();
    ok((await a.bridge.expectsFreeText(CHAT)) === true, "owner expects free text");
    ok((await b.bridge.expectsFreeText(CHAT)) === false, "other instance does not");
    await a.bridge.handleCallback({ id: "cb", data: callbackDataOf(a.bot.sent.at(-1)).replace(/:[0-9]+$/, ":f"), message: { chat: { id: CHAT } } });
    await a.bridge.handleMessage({ chat: { id: CHAT }, message_id: 9, text: "my answer" });
    eq(await done, [["my answer"]], "typed message resolved the question");
  } finally {
    await teardown(a.bridge, b.bridge);
  }
}

async function testFormPresentedAndTapped() {
  console.log("form: question form is mirrored; a tap replies over HTTP and settles");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form1", formClient: fc });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: SINGLE_FORM } });
    ok(bot.sent.length === 1, "one card for the single question");
    ok(bot.sent[0].text.includes("Which approach should we take?"), "card carries the question text");
    const data0 = callbackDataOf(bot.sent[0]);
    ok(data0?.startsWith("f:frm_single01:"), "card encodes the form ID (f: callback)");
    eq(bridge.questions.size, 1, "one wait registered");
    ok([...bridge.formWaits.keys()].includes("frm_single01"), "wait keyed by form id");

    await bridge.handleCallback({ id: "cb", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies, [{ sessionID: BOUND, formID: "frm_single01", answer: { q0: "Option A" } }], "tap replies to the form over HTTP (scalar for string field)");
    eq(bridge.questions.size, 0, "wait removed after delivery");
    ok(bot.edits.some((edit) => edit.text.includes("✅ Answered: Option A")), "card shows the picked answer");
  } finally {
    await teardown(bridge);
  }
}

async function testTwoQuestionSequence() {
  console.log("form: with two questions nothing delivers until ALL are answered");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form1b", formClient: fc });
  try {
    await presentDefaultForm(bridge);
    const data0 = callbackDataOf(bot.sent[0]);
    const data1 = callbackDataOf(bot.sent[1]);
    await bridge.handleCallback({ id: "c1", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies.length, 0, "partial answers do not settle the form");
    eq(bridge.questions.size, 1, "wait still open");
    await bridge.handleCallback({ id: "c2", data: data1, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies.length, 0, "multiselect toggle alone does not settle the form");
    await bridge.handleCallback({ id: "c3", data: `f:frm_test0001:1:d`, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies, [{ sessionID: BOUND, formID: "frm_test0001", answer: { q0: "Option A", q1: ["X"] } }], "full answer delivered once complete");
    eq(bridge.questions.size, 0, "wait settled");
  } finally {
    await teardown(bridge);
  }
}

async function testMultiselectDoneFlow() {
  console.log("form: multiselect collects toggles and delivers an array");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form2", formClient: fc });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: MULTIFORM } });
    const data1 = callbackDataOf(bot.sent[0]); // q1 first option (X)
    const doneData = `f:frm_multi001:0:d`;
    await bridge.handleCallback({ id: "c1", data: data1, message: { chat: { id: CHAT } } });
    await bridge.handleCallback({ id: "c2", data: doneData, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies.at(-1)?.answer, { q1: ["X"] }, "multiselect delivered as an array");
    eq(bridge.questions.size, 0, "wait settled");
  } finally {
    await teardown(bridge);
  }
}

async function testTuiAnswersFirst() {
  console.log("form: TUI-first reply updates the cards; later taps say expired");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form3", formClient: fc });
  try {
    await presentDefaultForm(bridge);
    await bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_test0001", sessionID: BOUND, answer: { q0: "From the TUI", q1: ["X"] } },
    });
    eq(bridge.questions.size, 0, "wait settled by the event");
    eq(fc.replies.length, 0, "no HTTP reply from our side");
    ok(bot.edits.some((edit) => edit.text.includes("From the TUI")), "card shows the TUI's answer");
    const data0 = callbackDataOf(bot.sent[0]);
    await bridge.handleCallback({ id: "cb", data: data0, message: { chat: { id: CHAT } } });
    eq(bot.answers.at(-1)?.text, "This question has expired.", "stale tap after TUI answer");
  } finally {
    await teardown(bridge);
  }
}

async function testFormCancelledEvent() {
  console.log("form: cancelled form closes the cards with a dismissal note");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form4", formClient: fc });
  try {
    await presentDefaultForm(bridge);
    await bridge.onEvent({ type: "form.cancelled", data: { id: "frm_test0001", sessionID: BOUND } });
    eq(bridge.questions.size, 0, "wait removed");
    ok(bot.edits.some((edit) => edit.text.includes("⏹ Dismissed.")), "cards say why they died");
    ok(fc.cancels.length === 0, "we do not cancel an already-cancelled form");
  } finally {
    await teardown(bridge);
  }
}

async function testFormTimeout() {
  console.log("form: timeout cancels the form with model-facing feedback");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({
    token: "tok-form5",
    formClient: fc,
    options: { questionTimeoutMs: 80 },
  });
  try {
    await presentDefaultForm(bridge);
    await tick(200);
    eq(fc.cancels, [{ sessionID: BOUND, formID: "frm_test0001", message: "No answer (timed out)." }], "form cancelled with message");
    ok(bot.edits.some((edit) => edit.text.includes("⏱ No answer (timed out).")), "cards note the timeout");
    eq(bridge.questions.size, 0, "wait gone");
  } finally {
    await teardown(bridge);
  }
}

async function testDeliveryFailureAndRetry() {
  console.log("form: failed delivery keeps a Retry button; retry delivers");
  let attempts = 0;
  const fc = makeFormClient({
    reply(input) {
      attempts++;
      if (attempts === 1) throw new Error("connection blip");
    },
  });
  const { bridge, bot } = await makeBridge({ token: "tok-form6", formClient: fc });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: SINGLE_FORM } });
    const data0 = callbackDataOf(bot.sent[0]);
    await bridge.handleCallback({ id: "c1", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    ok(attempts === 1 && bridge.questions.size === 1, "first delivery failed, wait kept alive");
    ok(bot.edits.some((edit) => edit.text.includes("⚠️ Could not deliver the answer to OpenCode: connection blip")), "failure note on the card");
    ok(bot.edits.some((edit) => edit.keyboard?.inline_keyboard?.flat().some((btn) => btn.callback_data?.endsWith(":r"))), "Retry button present");

    await bridge.handleCallback({ id: "c2", data: `f:frm_single01:0:r`, message: { chat: { id: CHAT } } });
    await tick();
    ok(attempts === 2, "retry attempted");
    eq(bridge.questions.size, 0, "settled after successful retry");
  } finally {
    await teardown(bridge);
  }
}

async function testAlreadySettledRace() {
  console.log("form: AlreadySettled race shows the answer that actually won");
  const fc = makeFormClient({
    reply() {
      const error = new Error("Form already settled: frm_single01");
      throw error;
    },
    get() {
      return { state: { status: "answered", answer: { q0: "TUI won" } } };
    },
  });
  const { bridge, bot } = await makeBridge({ token: "tok-form7", formClient: fc });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: SINGLE_FORM } });
    const data0 = callbackDataOf(bot.sent[0]);
    await bridge.handleCallback({ id: "cb", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    ok(bot.edits.some((edit) => edit.text.includes("TUI won")), "card shows the winning answer");
    eq(bridge.questions.size, 0, "wait settled");
  } finally {
    await teardown(bridge);
  }
}

async function testTypedAnswerDeliversForm() {
  console.log("form: a typed message answers the open form card");
  const fc = makeFormClient();
  const { bridge } = await makeBridge({ token: "tok-form8", formClient: fc });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: SINGLE_FORM } });
    await bridge.handleMessage({ chat: { id: CHAT }, message_id: 11, text: "my custom answer" });
    await tick();
    eq(fc.replies.at(-1)?.answer, { q0: "my custom answer" }, "free text delivered as the answer");
    eq(bridge.questions.size, 0, "wait settled after typed answer");
  } finally {
    await teardown(bridge);
  }
}

async function testStopDetachesForm() {
  console.log("form: reload detaches the mirror without cancelling the TUI poll");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form9", formClient: fc });
  await presentDefaultForm(bridge);
  await bridge.stop();
  await tick();
  ok(fc.cancels.length === 0, "form NOT cancelled on stop");
  eq(bridge.questions.size, 0, "wait dropped");
  ok(bot.edits.some((edit) => edit.text.includes("🔄 OpenCode reloaded")), "cards announce the reload");
}

async function testSweepReattachesPendingForms() {
  console.log("form: sweep re-presents pending forms after a reload");
  const fc = makeFormClient({ list: () => [QUESTION_FORM] });
  const { bridge, bot } = await makeBridge({
    token: "tok-form10",
    formClient: fc,
    ctx: makeCtx([BOUND]),
  });
  try {
    await tick(60);
    ok(bot.sent.length >= 2, "pending form re-presented at startup");
    ok([...bridge.formWaits.keys()].includes("frm_test0001"), "wait re-registered");
  } finally {
    await teardown(bridge);
  }
}

async function testNonQuestionFormGetsNotice() {
  console.log("form: foreign forms still get a visible notice");
  const fc = makeFormClient();
  const { bridge, bot } = await makeBridge({ token: "tok-form11", formClient: fc });
  try {
    await bridge.onEvent({
      type: "form.created",
      data: { form: { id: "frm_other", sessionID: BOUND, title: "Sign in", fields: [{ key: "f0", type: "external", url: "https://x" }] } },
    });
    ok(bot.sent.length === 1 && bot.sent[0].text.includes("could not take this one over"), "notice sent");
    eq(bridge.questions.size, 0, "no wait registered");
  } finally {
    await teardown(bridge);
  }
}

async function testNoClientFallsBackToNotice() {
  console.log("form: without a form client, forms get the notice (hijack mode territory)");
  const { bridge, bot } = await makeBridge({ token: "tok-form12", formClient: undefined });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: QUESTION_FORM } });
    ok(bot.sent.length === 1 && bot.sent[0].text.includes("could not take this one over"), "notice sent, no mirror");
    eq(bridge.questions.size, 0, "no wait registered");
  } finally {
    await teardown(bridge);
  }
}

async function testFormMirrorsUnboundLocalSession() {
  console.log("form: questions from ANY local session are mirrored (not just the bound one)");
  const fc = makeFormClient();
  const localForm = { ...SINGLE_FORM, id: "frm_local001", sessionID: "ses_other_local" };
  const { bridge, bot } = await makeBridge({
    token: "tok-form13",
    formClient: fc,
    ctx: makeCtx([], { ses_other_local: { directory: "/test" } }),
  });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: localForm } });
    ok(bot.sent.length === 1, "card sent for the unbound local session");
    ok([...bridge.formWaits.keys()].includes("frm_local001"), "wait registered");
    const data0 = callbackDataOf(bot.sent[0]);
    await bridge.handleCallback({ id: "cb", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    eq(fc.replies, [{ sessionID: "ses_other_local", formID: "frm_local001", answer: { q0: "Option A" } }], "tap replies against THAT session's form");
  } finally {
    await teardown(bridge);
  }
}

async function testFormSkipsForeignSession() {
  console.log("form: questions from another location's session are left alone");
  const fc = makeFormClient();
  const foreignForm = { ...SINGLE_FORM, id: "frm_foreign1", sessionID: "ses_foreign" };
  const { bridge, bot } = await makeBridge({
    token: "tok-form14",
    formClient: fc,
    ctx: makeCtx([], { ses_foreign: { directory: "/elsewhere" } }),
  });
  try {
    await bridge.onEvent({ type: "form.created", data: { form: foreignForm } });
    ok(bot.sent.length === 0, "no card, no notice");
    eq(bridge.questions.size, 0, "no wait");
  } finally {
    await teardown(bridge);
  }
}

async function testStaleBindingClearedAtStart() {
  console.log("bind: a stored session that no longer exists is unbound at startup");
  const gone = "ses_gone0000000000000";
  const ctx = makeCtx([], { [gone]: "missing" }, { session: gone, chat: CHAT });
  const bot = makeBot();
  const bridge = new Bridge(ctx, makeOptions("tok-form15", { sessionID: undefined }), bot, undefined);
  await bridge.start();
  try {
    eq(await ctx.storage.get("session"), "", "stale binding cleared from KV");
    eq(bridge.sessionID, undefined, "bridge no longer bound to the dead session");
  } finally {
    await teardown(bridge);
  }
}

async function testLiveBindingSurvivesStart() {
  console.log("bind: a valid stored session stays bound");
  const ctx = makeCtx([], {}, { session: BOUND, chat: CHAT });
  const bot = makeBot();
  const bridge = new Bridge(ctx, makeOptions("tok-form16", { sessionID: undefined }), bot, undefined);
  await bridge.start();
  try {
    eq(bridge.sessionID, BOUND, "binding kept");
    eq(await ctx.storage.get("session"), BOUND, "KV untouched");
  } finally {
    await teardown(bridge);
  }
}

async function testFormTapAdoptedByFreshInstance() {
  console.log("form: after a reload, a FRESH instance claims the tap from the KV record");
  const fcA = makeFormClient();
  const fcB = makeFormClient();
  const ctx = makeCtx([], { ses_other_local: { directory: "/test" } });
  const a = await makeBridge({ token: "tok-form17", formClient: fcA, ctx });
  const localForm = { ...SINGLE_FORM, id: "frm_adopt001", sessionID: "ses_other_local" };
  await a.bridge.onEvent({ type: "form.created", data: { form: localForm } });
  const data0 = callbackDataOf(a.bot.sent[0]);
  ok(data0?.startsWith(`f:frm_adopt001:`), "form card encodes the form ID (stateless tap)");
  await a.bridge.stop(); // simulate the reload churn

  const b = await makeBridge({ token: "tok-form17b", formClient: fcB, ctx });
  try {
    ok((await b.bridge.wantsCallback(data0, CHAT)) === true, "fresh instance claims the tap via the record");
    await b.bridge.handleCallback({ id: "cb", data: data0, message: { chat: { id: CHAT } } });
    await tick();
    eq(fcB.replies, [{ sessionID: "ses_other_local", formID: "frm_adopt001", answer: { q0: "Option A" } }], "adopted tap delivers over HTTP");
    eq(fcA.replies.length, 0, "the dead instance did nothing");
    ok(b.bot.edits.some((edit) => edit.text.includes("✅ Answered: Option A")), "cards closed by the adopter");
  } finally {
    await teardown(b.bridge);
  }
}

async function testProviderAlertClassification() {
  console.log("alerts: provider errors classify by status/message");
  const { classifyProviderError } = await import("../test-dist/opencode-telegram-bridge/src/bridge.js");
  eq(classifyProviderError({ status: 429, message: "rate limit exceeded" }).label, "Rate limited", "429 → rate limited");
  eq(classifyProviderError({ message: "you hit your daily limit" }).label, "Quota / limit reached", "daily limit wording → quota");
  eq(classifyProviderError({ status: 402, message: "payment required" }).label, "Quota / limit reached", "402 → quota");
  eq(classifyProviderError({ status: 401, message: "invalid api key" }).label, "Auth error", "401 → auth");
  eq(classifyProviderError({ status: 503, message: "service unavailable" }).label, "Provider unreachable", "5xx → unreachable");
  eq(classifyProviderError({ message: "fetch failed: ECONNREFUSED" }).label, "Provider unreachable", "network wording → unreachable");
  eq(classifyProviderError({ status: 400, message: "bad request" }).label, "Provider error 400", "other 4xx → generic");
}

async function testProviderRetryAlert() {
  console.log("alerts: retry.scheduled notifies with attempt + delay, dedupes repeats");
  const { bridge, bot } = await makeBridge({ token: "tok-alert1" });
  try {
    await bridge.onEvent({
      type: "session.retry.scheduled",
      data: { sessionID: BOUND, assistantMessageID: "msg_1", attempt: 2, at: Date.now() + 8000, error: { type: "provider", message: "Rate limit exceeded", status: 429, retryAfterMs: 8000 } },
    });
    ok(bot.sent.some((s) => s.text.includes("🚦 Rate limited")), "rate-limit alert sent");
    ok(bot.sent.some((s) => s.text.includes("(attempt 2)")), "attempt number shown");
    ok(bot.sent.some((s) => s.text.includes("retrying in 8s")), "retry delay shown");
    ok(bot.sent.some((s) => s.text.includes("Rate limit exceeded")), "provider message shown");

    // Same category again within 3 minutes → suppressed.
    const before = bot.sent.length;
    await bridge.onEvent({
      type: "session.retry.scheduled",
      data: { sessionID: BOUND, assistantMessageID: "msg_1", attempt: 3, at: Date.now() + 16000, error: { type: "provider", message: "Rate limit exceeded", status: 429, retryAfterMs: 16000 } },
    });
    eq(bot.sent.length, before, "repeat rate-limit alert silenced");
    // A DIFFERENT category still goes through immediately.
    await bridge.onEvent({
      type: "session.retry.scheduled",
      data: { sessionID: BOUND, assistantMessageID: "msg_1", attempt: 1, at: Date.now() + 1000, error: { type: "provider", message: "fetch failed: ECONNREFUSED" } },
    });
    ok(bot.sent.some((s) => s.text.includes("📡 Provider unreachable")), "different category not silenced");
  } finally {
    await teardown(bridge);
  }
}

async function testProviderAlertsDisabledAndStepFailed() {
  console.log("alerts: providerAlerts:false silences; step.failed notifies once");
  const { bridge, bot } = await makeBridge({ token: "tok-alert2", options: { providerAlerts: false } });
  try {
    await bridge.onEvent({
      type: "session.retry.scheduled",
      data: { sessionID: BOUND, assistantMessageID: "msg_1", attempt: 1, at: Date.now(), error: { type: "provider", message: "Rate limit exceeded", status: 429 } },
    });
    eq(bot.sent.length, 0, "no alerts when disabled");
  } finally {
    await teardown(bridge);
  }

  const b2 = await makeBridge({ token: "tok-alert3" });
  try {
    const error = { type: "provider", message: "Provider overloaded", status: 503 };
    await b2.bridge.onEvent({ type: "session.step.failed", data: { sessionID: BOUND, assistantMessageID: "msg_2", error } });
    ok(b2.bot.sent.some((s) => s.text.includes("Step failed — Provider unreachable")), "step failure alert sent");
    const before = b2.bot.sent.length;
    await b2.bridge.onEvent({ type: "session.step.failed", data: { sessionID: BOUND, assistantMessageID: "msg_3", error } });
    eq(b2.bot.sent.length, before, "duplicate step failure silenced");
    await b2.bridge.onEvent({ type: "session.compaction.failed", data: { sessionID: BOUND, error: { message: "context too large" } } });
    ok(b2.bot.sent.some((s) => s.text.includes("Compaction failed")), "compaction failure alert sent");
  } finally {
    await teardown(b2.bridge);
  }
}

const tests = [
  testHubSharedSinglePoller,
  testCallbackRoutingAndStale,
  testFreeTextExpectation,
  testFormPresentedAndTapped,
  testTwoQuestionSequence,
  testMultiselectDoneFlow,
  testTuiAnswersFirst,
  testFormCancelledEvent,
  testFormTimeout,
  testDeliveryFailureAndRetry,
  testAlreadySettledRace,
  testTypedAnswerDeliversForm,
  testStopDetachesForm,
  testSweepReattachesPendingForms,
  testNonQuestionFormGetsNotice,
  testNoClientFallsBackToNotice,
  testFormMirrorsUnboundLocalSession,
  testFormSkipsForeignSession,
  testStaleBindingClearedAtStart,
  testLiveBindingSurvivesStart,
  testFormTapAdoptedByFreshInstance,
  testProviderAlertClassification,
  testProviderRetryAlert,
  testProviderAlertsDisabledAndStepFailed,
];

for (const test of tests) {
  try {
    await test();
  } catch (error) {
    fail++;
    failures.push(`${test.name} threw: ${error?.stack ?? error}`);
    console.log(`  ✗ ${test.name} threw: ${error?.message ?? error}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
