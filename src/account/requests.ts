// What a device asks the account to do: the extension's own handlers (hands/background.js), run here through
// the same engine calls. The gate, the chat and a loosening ask Claude from inside the account, so the
// account's daily allowance is counted once for all its devices.

import { UpstreamError } from "../claude";
import { type Env, intVar } from "../env";
import { gate } from "../gate";
import { loosen } from "../loosen";
import { reserveCall, recordTokens } from "../quota";
import { rules } from "../rules";
import { BadRequest, gateInput, isObject, loosenInput, rulesInput } from "../validate";
import { engine, inZone, type State } from "./engine";

export interface Ctx {
  env: Env;
  accountId: string;
  tz: string;
  now: number;
  ip: string | null;
  deviceKind: string;
  /** For waitUntil: token counts are recorded after the answer. */
  waitUntil: (p: Promise<unknown>) => void;
}

export interface Done {
  state: State;
  result: Record<string, unknown>;
  /** A pass the gate granted: the account runs it down on real time from now. */
  pass?: { domain: string; seconds: number };
}

type Handler = (state: State, req: Record<string, any>, ctx: Ctx) => Promise<Done> | Done;

const E = (ctx: Ctx) => <T>(fn: () => T) => inZone(ctx.tz, fn);

/** A Claude call through the relay's own endpoint logic, under the account's allowance. */
async function claude<T>(ctx: Ctx, allowance: { name: string; max: number } | null, call: () => Promise<{ result: T; tokens: number }>):
  Promise<{ ok: true; data: T } | { ok: false; error: string; scope?: string }> {
  const full = await reserveCall(ctx.env, ctx.accountId, ctx.ip, allowance ? { name: allowance.name, maxCalls: allowance.max, shared: false } : undefined);
  if (full) return { ok: false, error: "daily_limit", scope: full };
  try {
    const { result, tokens } = await call();
    ctx.waitUntil(recordTokens(ctx.env, ctx.accountId, tokens, !allowance));
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof UpstreamError) return { ok: false, error: err.message };
    if (err instanceof BadRequest) return { ok: false, error: "bad_payload" };
    throw err;
  }
}

const withId = (ctx: Ctx, payload: Record<string, unknown>) => ({ ...payload, installId: ctx.accountId });

export const HANDLERS: Record<string, Handler> = {
  setup(s, req, ctx) {
    const out = E(ctx)(() => engine.completeSetup(s, { kinds: isObject(req.kinds) ? req.kinds : {}, goal: req.goal }, ctx.now));
    return { state: out.state, result: { now: out.now, later: out.later, from: out.from } };
  },
  propose(s, req, ctx) {
    if (!isObject(req.rules)) return { state: s, result: { refused: "bad_rules" } };
    const out = E(ctx)(() => engine.proposeRules(s, req.rules, ctx.now, { undoable: !!req.undoable, source: ctx.deviceKind }));
    const state = req.goal === undefined ? out.state : engine.setGoal(out.state, req.goal);
    return { state, result: { now: out.now, later: out.later, from: out.from, needsOk: !!out.needsOk, refused: out.refused } };
  },
  goal(s, req) {
    return { state: engine.setGoal(s, req.goal), result: { ok: true } };
  },
  consent(s, req, ctx) {
    let n = s;
    const seeAll = !!req.seeAll;
    E(ctx)(() => {
      if (req.help !== undefined) n = engine.setHelp(n, !!req.help, { sorting: seeAll });
      if (req.talk !== undefined) n = engine.setTalk(n, !!req.talk);
      if (req.sorting !== undefined) n = engine.setSorting(n, !!req.sorting && seeAll);
      if (req.chat !== undefined) n = engine.setConsent(n, "chat", !!req.chat);
      if (req.judge !== undefined) n = engine.setConsent(n, "judge", !!req.judge);
    });
    const c = (name: string) => engine.consented(n, name);
    return { state: n, result: { talk: c("talk"), sorting: c("sorting") && !!n.sorting, chat: c("chat"), judge: c("judge"), help: c("help") } };
  },
  // One message at the gate. Claude is asked only if the engine says there is something to ask.
  async talk(s, req, ctx) {
    const url = typeof req.url === "string" ? req.url.slice(0, 2048) : "";
    const r = E(ctx)(() => engine.gateRequest(s, { url, message: req.message, now: ctx.now }));
    if (r.refused) return { state: s, result: { decision: "refused", reason: r.refused, until: r.until } };
    const answer = await claude(ctx, null, () => gate(ctx.env, gateInput(withId(ctx, r.payload))));
    if (!answer.ok) return { state: s, result: { decision: "error", error: answer.error, scope: answer.scope } };
    const out = E(ctx)(() => engine.applyGateAnswer(s, { url, answer: answer.data, now: ctx.now }));
    const res = out.result;
    const pass = res.decision === "allow" && res.site ? { domain: res.site as string, seconds: (res.minutes as number) * 60 } : undefined;
    return { state: out.state, result: res, pass };
  },
  // One message in the one thread; an answer that changes rules comes back as a card in the copy.
  async chat(s, req, ctx) {
    const r = E(ctx)(() => engine.chatRequest(s, { message: req.message, now: ctx.now }));
    if (r.refused) return { state: s, result: { refused: r.refused } };
    let st = E(ctx)(() => engine.addTurn(s, "user", req.message, ctx.now));
    // A no holds only the rule it was about (Maxime, 2026-10-18); the engine refuses the held parts itself, so the
    // payload goes as the engine built it.
    const payload = withId(ctx, r.payload);
    const answer = await claude(ctx, { name: "rules", max: intVar(ctx.env.MAX_RULES_PER_INSTALL, 40) }, () => rules(ctx.env, rulesInput(payload)));
    const preview = answer.ok ? E(ctx)(() => engine.chatPreview(st, answer.data, ctx.now)) : null;
    if (!answer.ok || preview.error) {
      const failed = answer.ok ? preview.error : answer.error;
      st = E(ctx)(() => engine.addTurn(st, "gatekeeper", failed === "daily_limit" ? "That's enough changes by talking for today." : "Can't reach Claude right now. Your rules page still works.", ctx.now));
      return { state: st, result: { failed } };
    }
    st = E(ctx)(() => engine.recordChatAnswer(st, (answer as { data: unknown }).data, preview, ctx.now));
    return { state: st, result: { ok: true } };
  },
  applyCard(s, _req, ctx) {
    const out = E(ctx)(() => engine.applyCard(s, ctx.now));
    return { state: out.state, result: out.refused ? { refused: out.refused } : out.outcome };
  },
  dropCard(s, _req, ctx) {
    return { state: E(ctx)(() => engine.dropCard(s, ctx.now)), result: { ok: true } };
  },
  forgetThread(s) {
    return { state: engine.forgetThread(s), result: { ok: true } };
  },
  startExam(s, req, ctx) {
    const from = ctx.deviceKind === "mac" ? "mac" : ["today", "rules", "calendar"].includes(req.source) ? req.source : "extension";
    const out = E(ctx)(() => engine.startExam(s, { until: req.until, goal: req.goal, at: req.at, source: from }, ctx.now));
    return { state: out.state, result: { ok: !out.refused, refused: out.refused, exam: out.exam } };
  },
  endExam(s, _req, ctx) {
    const out = E(ctx)(() => engine.endExam(s, ctx.now));
    return { state: out.state, result: { refused: out.refused, until: out.until, needsOk: !!out.needsOk } };
  },
  // The reason for a loosening, to the agent who holds the key. Out of reach: nothing loosens, it keeps waiting.
  async loosen(s, req, ctx) {
    const r = E(ctx)(() => engine.loosenRequest(s, { message: req.message, now: ctx.now }));
    if (r.refused) return { state: s, result: { decision: "refused", reason: r.refused } };
    const answer = await claude(ctx, { name: "loosen", max: intVar(ctx.env.MAX_LOOSEN_PER_INSTALL, 10) }, () => loosen(ctx.env, loosenInput(withId(ctx, r.payload))));
    if (!answer.ok) {
      const out = E(ctx)(() => engine.loosenUnavailable(s, { message: req.message, error: answer.error, now: ctx.now }));
      return { state: out.state, result: { decision: "unavailable", error: answer.error } };
    }
    const out = E(ctx)(() => engine.applyLoosenAnswer(s, { answer: answer.data, message: req.message, now: ctx.now }));
    if (out.result.decision === "error") {
      const un = E(ctx)(() => engine.loosenUnavailable(s, { message: req.message, error: "bad_answer", now: ctx.now }));
      return { state: un.state, result: { decision: "unavailable", error: "bad_answer" } };
    }
    return { state: out.state, result: out.result };
  },
  dropLoosen(s, _req, ctx) {
    return { state: E(ctx)(() => engine.dropLoosen(s, ctx.now)), result: { ok: true } };
  },
  watch(s, req, ctx) {
    return { state: E(ctx)(() => engine.startWatch(s, { goal: req.goal }, ctx.now)), result: { ok: true } };
  },
  endWatch(s, _req, ctx) {
    return { state: E(ctx)(() => engine.endWatch(s, ctx.now)), result: { ok: true } };
  },
  watchShown(s) {
    return { state: engine.markWatchShown(s), result: { ok: true } };
  },
  dismissOffer(s, req) {
    return { state: engine.dismissOffer(s, req.offer), result: { ok: true } };
  },
  noteGate(s, _req, ctx) {
    return { state: E(ctx)(() => engine.noteGate(engine.rollover(s, ctx.now), ctx.now)), result: { ok: true } };
  },
  sorted(s, req) {
    const kind = typeof req.kind === "string" ? req.kind : "";
    if (typeof req.domain !== "string" || !kind) return { state: s, result: { refused: "bad_request" } };
    return { state: engine.recordSort(s, req.domain.toLowerCase().slice(0, 253), kind), result: { ok: true } };
  },
  judged(s, req, ctx) {
    if (typeof req.key !== "string" || !/^yt:[A-Za-z0-9_-]{6,20}$/.test(req.key)) return { state: s, result: { refused: "bad_request" } };
    const by = req.by === "claude" ? "claude" : "words";
    return { state: E(ctx)(() => engine.recordJudgment(s, req.key, req.rule ?? null, by, ctx.now)), result: { ok: true } };
  },
  // The coming events' titles and times from the device's calendar link (the engine keeps 14 days of them, for
  // the exam offer, examAt and the gate's deadlines). The link itself stays on the device.
  calendar(s, req, ctx) {
    const events = (Array.isArray(req.events) ? req.events : [])
      .filter((e: unknown) => isObject(e) && typeof e.title === "string" && typeof e.start === "number" && Number.isFinite(e.start))
      .filter((e: State) => e.start <= ctx.now + 14 * 86400e3 && e.start >= ctx.now - 2 * 86400e3)
      .slice(0, 20)
      .map((e: State) => ({ title: String(e.title).slice(0, 120), start: e.start }));
    return { state: { ...s, calendar: { url: null, events, fetchedAt: ctx.now, error: null } }, result: { ok: true } };
  },
};

/** What the Mac app may ask: only what tightens or says nothing (as in the native-messaging contract). */
export const MAC_ALLOWED = new Set(["startExam", "noteGate"]);
