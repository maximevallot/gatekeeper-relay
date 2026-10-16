// Runs the real Worker under `wrangler dev` against the fake Anthropic API and checks both endpoints.
// Usage: npm run smoke
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-anthropic.mjs";

const KEY = "sk-ant-smoke-not-a-real-key";

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const mock = await startMock(KEY);
const port = await freePort();
const state = mkdtempSync(join(tmpdir(), "gatekeeper-relay-smoke-"));
const wrangler = spawn(
  "npx",
  [
    "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state,
    "--show-interactive-dev-session=false",
    "--var", `ANTHROPIC_API_KEY:${KEY}`,
    "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`,
    "--var", "MAX_CALLS_PER_INSTALL:3",
  ],
  { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(base + "/");
      break;
    } catch {
      if (Date.now() > deadline || wrangler.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const installId = crypto.randomUUID();
  const gate = (message) => ({
    installId, goal: "Finish the PMR worksheet", site: "youtube.com", kind: "video",
    minutesUsed: 20, budget: 20, deadlines: [{ title: "PMR worksheet", due: "2026-10-18" }], message,
  });

  let r = await post("/gate", gate("I need the lecture 6 recording, it's only on YouTube"));
  check("gate allows a specific need, clamped to 10 minutes", r.status === 200 && r.body.decision === "allow" && r.body.minutes === 10, r);
  r = await post("/gate", gate("come on, just five minutes"));
  check("gate denies arguing with zero minutes", r.status === 200 && r.body.decision === "deny" && r.body.minutes === 0, r);
  r = await post("/gate", gate("it's for class"));
  check("gate asks when the need is vague", r.status === 200 && r.body.decision === "ask" && r.body.minutes === 0, r);
  r = await post("/gate", gate("one more"));
  check("fourth call from the same install hits the daily cap", r.status === 429 && r.body.scope === "install", r);

  r = await post("/gate", { ...gate("hi"), installId: "not-a-uuid" });
  check("gate rejects an invalid installId", r.status === 400 && r.body.error === "invalid_install_id", r);

  const before = mock.requests.length;
  r = await post("/sort", { installId: crypto.randomUUID(), domain: "agar.io", title: "Agar.io" });
  check("sort classifies agar.io as games", r.status === 200 && r.body.kind === "games", r);
  r = await post("/sort", { installId: crypto.randomUUID(), domain: "https://www.agar.io/", title: "" });
  check("sort serves the second user from the cache", r.status === 200 && r.body.kind === "games" && mock.requests.length === before + 1, {
    ...r, upstreamCalls: mock.requests.length - before,
  });
  r = await post("/sort", { domain: "agar.io", title: "" });
  check("sort rejects a missing installId", r.status === 400, r);

  r = await post("/gate", gate("x"), { Origin: "https://evil.example" });
  check("a web page origin is refused", r.status === 403, r);

  const upstream = mock.requests;
  check("every upstream call used the key, Haiku 5.5 and a JSON schema", upstream.length === 4 && upstream.every(
    (q) => q.key === KEY && q.body.model === "claude-haiku-5-5" && q.body.output_config?.format?.type === "json_schema",
  ), upstream.map((q) => ({ key: q.key, model: q.body.model })));
} catch (err) {
  console.error(err.message);
  failures++;
} finally {
  wrangler.kill("SIGINT");
  mock.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(state, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} smoke check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
