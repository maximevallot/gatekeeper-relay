// A fake Anthropic Messages API for the wrangler dev smoke test. No network, no key.
import { createServer } from "node:http";

const KINDS = { "agar.io": "games", "instagram.com": "social", "canvas.mit.edu": "study" };

function answer(body) {
  const user = body.messages?.[0]?.content ?? "";
  if (body.system?.includes("You sort websites")) {
    const domain = /^domain: (.+)$/m.exec(user)?.[1] ?? "";
    return { kind: KINDS[domain] ?? "other" };
  }
  if (body.system?.includes("You judge single videos")) {
    const title = /<title>(.*)<\/title>/.exec(user)?.[1] ?? "";
    if (/lecture|explained|tutorial/i.test(title)) return { rule: /- id: (v\d+)\n  about: educational/.exec(user)?.[1] ?? "none" };
    if (/minecraft|fortnite|gameplay/i.test(title)) return { rule: /- id: (v\d+)\n  about: video games/.exec(user)?.[1] ?? "none" };
    return { rule: "none" };
  }
  if (body.system?.includes("You change the rules of Gatekeeper")) {
    const said = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? "";
    if (/video games/i.test(said)) {
      return {
        reply: "You gave no limit for educational videos, so they are free.",
        question: null,
        diff: [
          { op: "addVideo", site: "youtube.com", about: "video games: gameplay, let's plays, streams", except: "educational videos about games",
            minutes: 0, words: { match: ["minecraft", "fortnite", "gameplay"], except: ["lecture", "explained", "tutorial"] } },
          { op: "addVideo", site: "youtube.com", about: "educational: lectures, tutorials, explainers", except: "",
            minutes: null, words: { match: ["lecture", "explained", "tutorial"], except: [] } },
        ],
      };
    }
    if (/instagram/i.test(said)) return { reply: "Social: 40 minutes a day.", question: null, diff: [{ op: "budget", kind: "social", minutes: 40 }] };
    return { reply: "", question: "Which sites or videos, and how many minutes a day?", diff: [] };
  }
const message = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? "";
  if (/lecture/i.test(message)) return { decision: "allow", minutes: 30, reply: "Five minutes for the lecture recording." };
  if (/class/i.test(message)) return { decision: "ask", minutes: 0, reply: "Which class, and what do you need?" };
  return { decision: "deny", minutes: 0, reply: "No." };
}

export function startMock(expectedKey) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: req.url, key: req.headers["x-api-key"], body });
      if (req.url !== "/v1/messages" || req.headers["x-api-key"] !== expectedKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key or path" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_smoke_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: JSON.stringify(answer(body)) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 800, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, close: () => server.close() })),
  );
}
