// The account end to end: the real Worker under `wrangler dev`, a fake Anthropic API, and three simulated
// devices (Brave, Safari, the Mac app), each with its own engine state made by the vendored engine.
// Usage: npm run smoke:account
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "../vendor/engine/engine.js";
import { startMock } from "./mock-anthropic.mjs";

const KEY = "sk-ant-smoke-not-a-real-key";
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A device's own state, as the extension's welcome leaves it. */
function deviceState(kinds, { seconds, help = true } = {}) {
  const now = Date.now();
  let s = engine.rollover(engine.initialState(), now);
  s = engine.completeSetup(s, { kinds, goal: "Finish problem set 4" }, now).state;
  if (help) s = engine.setHelp(s, true);
  if (seconds) s = { ...s, usage: { ...s.usage, seconds } };
  return s;
}

const mock = await startMock(KEY);
const port = await freePort();
const persist = mkdtempSync(join(tmpdir(), "gatekeeper-account-smoke-"));
const wrangler = spawn("npx", [
  "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false",
  "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`,
], { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  if (!ok) failures++;
}
async function call(path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ v: 1, tz: TZ, now: Date.now(), ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const sync = (token, body = {}) => call("/account/sync", body, token);

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { await fetch(base + "/"); break; } catch {
      if (Date.now() > deadline || wrangler.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 1. Brave finishes the welcome: the account is made from its state.
  const brave = await call("/account/create", { device: { name: "Brave on Mac", kind: "extension" }, state: deviceState({ social: 30, video: 45 }, { seconds: { social: 300 } }) });
  check("Brave creates the account from its own state", brave.status === 200 && brave.body.copy.rules.kinds.social.minutes === 30 && brave.body.copy.usage.seconds.social === 300, brave);
  const B = brave.body.device.token;

  // 2. Safari already had rules of its own; it joins with a code shown on Brave.
  const code = await call("/account/code", {}, B);
  check("Brave shows a 6-digit code", /^\d{6}$/.test(code.body.code ?? ""), code);
  const safari = await call("/account/join", { code: code.body.code, device: { name: "Safari on Mac", kind: "extension" }, state: deviceState({ social: 60, games: 15 }, { seconds: { social: 120 } }) });
  check("Safari joins: the account's rules stay whole", safari.status === 200 && safari.body.copy.rules.kinds.social.minutes === 30 && !safari.body.copy.rules.kinds.games, safari.body);
  check("Safari's own rules come back, to offer as a change", safari.body.merged?.rulesDiffer === true && safari.body.merged.lostRules.kinds.games.minutes === 15, safari.body.merged);
  check("today's minutes are added together", safari.body.copy.usage.seconds.social === 420, safari.body.copy.usage);
  const S = safari.body.device.token;
  const reused = await call("/account/join", { code: code.body.code, device: { name: "Chrome", kind: "extension" } });
  check("the code works only once", reused.status === 404, reused);

  // 3. YouTube in front in both browsers for the same 30 seconds counts once.
  const t = Date.now();
  await sync(B, { spans: [{ seq: 1, from: t - 60e3, to: t, buckets: ["video"] }] });
  const both = await sync(S, { spans: [{ seq: 1, from: t - 30e3, to: t, buckets: ["video"] }] });
  check("two browsers playing at once count once (60 s, not 90)", both.body.copy.usage.seconds.video === 60 && both.body.spansUpTo === 1, both.body.copy?.usage);

  // 4. A tighter rule on Safari applies at once, and Brave sees it at its next sync.
  const tight = await sync(S, { requests: [{ id: "s1", type: "propose", rules: { kinds: { social: { minutes: 10 }, video: { minutes: 0 } } } }] });
  check("Safari tightens social to 10 and closes video, at once", tight.body.results?.[0]?.needsOk === false && tight.body.copy.rules.kinds.social.minutes === 10, tight.body.results);
  const seen = await sync(B, {});
  check("Brave sees it at its next sync", seen.body.copy.rules.kinds.social.minutes === 10, seen.body.copy?.rules);

  // 5. The gate on Brave asks Claude through the account; the pass shows on Safari too.
  const gate = await sync(B, { requests: [{ id: "b1", type: "talk", url: "https://www.youtube.com/", message: "I need the lecture 6 recording" }] });
  const pass = gate.body.results?.[0];
  check("the gate gives a pass through the account", pass?.decision === "allow" && pass.site === "youtube.com" && pass.minutes === 10, gate.body.results);
  const passOnSafari = await sync(S, {});
  check("Safari's copy has the same pass", passOnSafari.body.copy.passes?.["youtube.com"]?.secondsLeft > 590, passOnSafari.body.copy?.passes);

  // 6. The chat on Brave makes a card; Safari applies it.
  const chat = await sync(B, { requests: [{ id: "b2", type: "chat", message: "i want to put a limit on the site lequipe" }] });
  check("the chat answers through the account with a card", chat.body.results?.[0]?.ok === true && !!chat.body.copy.thread.card, chat.body.results);
  const applied = await sync(S, { requests: [{ id: "s2", type: "applyCard" }] });
  check("Safari applies the card: lequipe.fr 15 min", applied.body.copy.rules.siteLimits?.["lequipe.fr"] === 15, applied.body.copy?.rules);

  // 7. The Mac app joins: it may start exam mode, nothing that loosens.
  const macCode = await call("/account/code", {}, S);
  const mac = await call("/account/join", { code: macCode.body.code, device: { name: "Gatekeeper for Mac", kind: "mac" } });
  const M = mac.body.device.token;
  const until = Date.now() + 4 * 3600e3;
  const macReq = await sync(M, { requests: [{ id: "m1", type: "startExam", until, goal: "15.425 midterm" }, { id: "m2", type: "propose", rules: { kinds: {} } }] });
  check("the Mac starts exam mode", macReq.body.results?.[0]?.ok === true && macReq.body.copy.rules.exam?.until === until, macReq.body.results);
  check("the Mac can't loosen", macReq.body.results?.[1]?.refused === "mac_cannot_loosen", macReq.body.results);
  const examOnBrave = await sync(B, {});
  check("exam mode reaches Brave", examOnBrave.body.copy.rules.exam?.until === until, examOnBrave.body.copy?.rules?.exam);

  // 8. Devices, a lost one removed, leaving, deleting.
  const devices = await call("/account/devices", {}, B);
  check("three devices are listed", devices.body.devices?.length === 3, devices.body);
  await call("/account/remove", { deviceId: mac.body.device.id }, B);
  const gone = await sync(M, {});
  check("a removed device's key stops working", gone.status === 401, gone);
  const left = await call("/account/leave", {}, S);
  check("Safari leaves with a full copy", left.body.ok === true && left.body.copy.rules.siteLimits?.["lequipe.fr"] === 15, left.body);
  const exported = await call("/account/export", {}, B);
  check("export has the state and no keys", exported.body.state?.rules && !JSON.stringify(exported.body).includes("keyHash"), Object.keys(exported.body || {}));
  const del = await call("/account/delete", {}, B);
  const after = await sync(B, {});
  check("delete removes the account at once", del.body.ok === true && after.status === 410, after);

  const upstream = mock.requests.filter((q) => q.path === "/v1/messages");
  check("every Claude call used the key and Haiku", upstream.length === 2 && upstream.every((q) => q.key === KEY && q.body.model === "claude-haiku-5-5"), upstream.length);
} catch (err) {
  console.error(err.message);
  failures++;
} finally {
  wrangler.kill("SIGINT");
  mock.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(persist, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} account check(s) failed` : "\nall account checks passed");
process.exit(failures ? 1 : 0);
