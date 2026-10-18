// The relay for local testing of the account: `wrangler dev` on http://127.0.0.1:8787 (or $PORT), with a
// fake Anthropic API, so nothing leaves the machine and no key is needed. Ctrl-C stops both.
// Usage: npm run dev:account          State is kept in .wrangler/account-dev; delete it to start over.
import { spawn } from "node:child_process";
import { startMock } from "./mock-anthropic.mjs";

const KEY = "sk-ant-dev-not-a-real-key";
const port = process.env.PORT || "8787";
const mock = await startMock(KEY);
const wrangler = spawn("npx", [
  "wrangler", "dev", "--port", port, "--ip", "127.0.0.1", "--persist-to", ".wrangler/account-dev", "--show-interactive-dev-session=false",
  "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`,
], { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "inherit" });
console.log(`relay: http://127.0.0.1:${port}  (fake Claude on port ${mock.port})`);
const stop = () => { wrangler.kill("SIGINT"); mock.close(); setTimeout(() => process.exit(0), 300); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
wrangler.on("exit", (code) => { mock.close(); process.exit(code ?? 0); });
