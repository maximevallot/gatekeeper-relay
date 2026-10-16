# gatekeeper-relay

The server that stands between the Gatekeeper browser extension and Claude. It holds the Anthropic API key as a Cloudflare secret, so the key never ships inside the extension, and it enforces the limits that keep a student, or someone abusing the endpoint, from spending more than a few cents a day.

It is a Cloudflare Worker in TypeScript. It has two endpoints, both `POST` with a JSON body, and one model: Claude Haiku 5.5 (`claude-haiku-5-5`, the newest Haiku as of 2026-10-16, $0.10 per million input tokens and $0.50 per million output tokens).

Milestone 1 of Gatekeeper makes no network calls. This relay is for milestone 2: the gate's single box for a real need, and sorting sites the extension does not know into a kind.

## Endpoints

### `POST /gate`

The person is at the gate page of a blocked site and typed one message. The gate starts from no: a short, specific real need gets a short pass, a vague need gets one question back, and arguing gets nothing.

```json
{
  "installId": "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
  "goal": "Finish the 15.390 PMR worksheet",
  "site": "youtube.com",
  "kind": "video",
  "minutesUsed": 20,
  "budget": 20,
  "deadlines": [{ "title": "15.390 PMR worksheet", "due": "2026-10-18" }],
  "message": "I need the lecture 6 recording, it's only on YouTube"
}
```

```json
{ "decision": "allow", "minutes": 5, "reply": "Five minutes for the lecture recording." }
```

- `decision` is `allow`, `deny` or `ask`. Only `allow` carries minutes; `deny` and `ask` always have `minutes: 0`.
- The server has the last word on minutes: a pass is at least 1 and at most `MAX_PASS_MINUTES` (10), whatever the model says.
- If the model refuses, or returns something that is not one of the three decisions, the answer is `deny` with 0 minutes.
- `deadlines` is up to 10 items, each `{title, due}` or a plain string. The prompt tells the model it cannot know whether a deadline was submitted, so it never calls one overdue. (On 14 October the old gate told Maxime a worksheet was overdue that Anders had already submitted for the team.)
- Limits: `message` 1 to 500 characters, `goal` up to 300, `minutesUsed` and `budget` 0 to 1440, `kind` one of the eight kinds below.

### `POST /sort`

Sorts a domain the extension does not know, such as `agar.io`, into one kind: `social`, `video`, `games`, `news`, `shopping`, `work`, `study`, `other`.

```json
{ "installId": "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", "domain": "agar.io", "title": "Agar.io" }
```

```json
{ "kind": "games" }
```

- The answer is cached per domain for every user, for 90 days, in Workers KV. A cached answer makes no Claude call and does not count against any limit.
- The domain is normalized first: `https://www.Agar.io/play` and `agar.io` are the same entry.
- A refusal or an answer off the list returns `other` and is not cached, so the next request tries again.
- `installId` is not in the original spec for this endpoint; it is required here so the daily caps apply to it too.

### Errors

Every error is JSON `{ "error": "<code>" }`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_install_id`, `invalid_kind`, `missing_message`, `message_too_long`, `invalid_json`, `body_too_large`, … | The request is malformed. No Claude call was made. |
| 403 | `origin_not_allowed` | The request came from a web page, not the extension. |
| 429 | `daily_limit` with `scope`: `install`, `ip` or `global` | A daily cap is reached. Resets at 00:00 UTC (20:00 in Boston during daylight time). |
| 502 | `upstream_error` | The Anthropic API failed. |
| 503 | `upstream_busy` | The Anthropic API is overloaded or rate-limited us. |

The extension should fail closed: on any error the gate stays shut and the page says the gate cannot be reached.

## Limits

All are `vars` in [wrangler.jsonc](wrangler.jsonc), counted per UTC day in a Durable Object, so each count is exact even under concurrent requests.

| Var | Default | What it stops |
| --- | --- | --- |
| `MAX_CALLS_PER_INSTALL` | 60 | One install calling Claude all day. |
| `MAX_TOKENS_PER_INSTALL` | 40000 | One install sending long requests. About 30 to 40 gates. |
| `MAX_CALLS_PER_IP` | 300 | One machine minting fresh installIds to reset its caps. |
| `GLOBAL_DAILY_TOKENS` | 3000000 | Everything together. At Haiku 5.5 prices this is at most $0.30 a day if all input, $1.50 if all output. |
| `MAX_PASS_MINUTES` | 10 | The longest pass the gate may grant. |
| `ALLOWED_ORIGINS` | empty | Empty allows any `chrome-extension://` origin (Chrome and Brave). Set it to the extension's own origin once it has a fixed ID. |

`installId` must be a UUID. The extension makes one with `crypto.randomUUID()` on first run and keeps it in `chrome.storage.local`.

## Cost

Estimated from the prompt sizes; no real call has been made yet.

- A gate sends about 1,000 to 1,200 input tokens (the [gate prompt](prompts/gate.md) is about 3,300 characters, plus the context) and gets back about 50 tokens of JSON, plus whatever the model thinks at `effort: low`. Call it 1,200 in and 250 out: about $0.00025, so roughly 4,000 gates per dollar.
- A sort is about 600 in and 50 out: about $0.0001, once per domain for all users.
- The first real calls should confirm this: the Anthropic Console shows token counts per request.

## Prompts

The two prompts are plain Markdown files, bundled into the Worker as text:

- [prompts/gate.md](prompts/gate.md): the gate's rules, decisions and reply style.
- [prompts/sort.md](prompts/sort.md): the eight kinds with examples.

Editing a prompt needs only a redeploy. If you change the kinds or how sorting works, bump `CACHE_PREFIX` in [src/sort.ts](src/sort.ts) (`kind:v1:` to `kind:v2:`) so old answers are not reused.

What the person typed and the page title are wrapped in `<message>` and `<title>` tags, with any copy of those tags stripped out, and both prompts say to treat that text as data. The server-side clamp is the real protection: even a message that talks the model into anything gets at most `MAX_PASS_MINUTES`.

## Privacy

- The relay logs no request bodies. What a student types at the gate goes to the Anthropic API and nowhere else; Anthropic's commercial API terms govern what they keep.
- The sort cache stores only `domain → kind`. Page titles are sent to Claude and not stored.
- The quota counters store a day, a call count and a token count per install and per IP. Durable Objects are addressed by a hash of the name, and the relay never lists them.

## Running it locally

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs three things, none of which needs a key or an account or touches the network:

1. `npm run typecheck`: TypeScript.
2. `npm test`: 25 vitest tests inside the Workers runtime (`@cloudflare/vitest-plugin`), with a mocked Anthropic API. They cover the request sent to Claude, the minute clamp, refusals and bad output, upstream failures, installId and field validation, every cap, the sort cache, and origins.
3. `npm run smoke`: starts the real Worker under `wrangler dev`, points it at a fake Anthropic server on localhost ([scripts/mock-anthropic.mjs](scripts/mock-anthropic.mjs)) and checks both endpoints end to end.

To try it against the real API locally, copy `.dev.vars.example` to `.dev.vars`, put a key in it, and run `npm run dev`. `.dev.vars` is git-ignored.

## Steps left for Maxime

Nothing here has been deployed, and no account or key has been created. These are the steps, in order.

### 1. Get an Anthropic API key

1. Decide where the money comes from. If the MIT Sandbox funding is approved, check whether it arrives as Anthropic API credits for an organization, or as money you spend on a card. Either way the key comes from the Claude Console.
2. Sign in at https://console.anthropic.com with the account that should own the bill, or create an organization for Gatekeeper. A Claude.ai Pro or Max subscription cannot be used here: subscriptions are not for third-party apps, and the API is billed separately.
3. Under **Billing**, add credits or a card.
4. Under **Limits** (or the workspace's limits), set a monthly spend limit, for example $20. This is the second ceiling behind `GLOBAL_DAILY_TOKENS`.
5. Optionally create a workspace named `gatekeeper`, so its usage and limits are separate from anything else.
6. Under **API keys**, create a key named `gatekeeper-relay` in that workspace. Copy it once; you will paste it into Wrangler in step 3.6, and nowhere else. Do not put it in a file in any repository.

### 2. Create a Cloudflare account

1. Sign up at https://dash.cloudflare.com/sign-up. The free plan covers this: Workers, Workers KV, and SQLite-backed Durable Objects.
2. In **Workers & Pages**, pick a `workers.dev` subdomain when asked. The relay's address will be `https://gatekeeper-relay.<subdomain>.workers.dev`.

### 3. Deploy

From this folder:

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create SORT_CACHE
```

That prints an `id`. Put it in [wrangler.jsonc](wrangler.jsonc) in place of `REPLACE_WITH_KV_NAMESPACE_ID`.

```bash
npm run check
```

```bash
npm run deploy
```

Wrangler prints the Worker's URL. Then add the key as a secret; Wrangler asks you to paste it, and it redeploys with the secret:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### 4. Try one real call

This costs about $0.0003. Replace the URL with yours.

```bash
curl -s https://gatekeeper-relay.YOUR-SUBDOMAIN.workers.dev/sort -H 'content-type: application/json' -d '{"installId":"6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f","domain":"agar.io","title":"Agar.io"}'
```

It should print `{"kind":"games"}`. Then check the request in the Claude Console under **Usage** or **Logs**, and compare its token counts with the estimate in **Cost** above.

### 5. Connect the extension (milestone 2)

1. Add the relay URL to the extension's `host_permissions` in its manifest.
2. On first run, make an installId with `crypto.randomUUID()` and keep it in `chrome.storage.local`.
3. Once the extension has a fixed ID (a packed or published extension), set `ALLOWED_ORIGINS` in [wrangler.jsonc](wrangler.jsonc) to `chrome-extension://<that id>` and run `npm run deploy` again.

### If the key leaks

Create a new key in the Console, run `npx wrangler secret put ANTHROPIC_API_KEY` with it, then delete the old key in the Console.

### Not done, and needing your yes

- This repository exists only on this laptop. No GitHub repository has been created; say if you want one.

## Known limits

- **installIds are self-issued.** Anyone can make a UUID, so the per-install cap alone does not stop abuse; the per-IP cap and the global ceiling bound it. A signed install token issued by a `/register` endpoint would close this if it matters.
- **Sort answers are shared.** The first title sent for a domain shapes the answer every user gets for 90 days. The prompt says to judge the domain, not the page, and to ignore instructions in the title; a wrong kind can be fixed by deleting the KV key `kind:v1:<domain>` in the Cloudflare dashboard.
- **Students behind one NAT** share the per-IP cap of 300 calls a day. Raise `MAX_CALLS_PER_IP` if a campus network trips it.
- **No limit on passes per day.** The call cap bounds it at 60 tries; the extension can add its own rule if passes pile up.
- **Prompt caching is off.** The gate prompt is likely shorter than the minimum cacheable prefix for Haiku, so it would save little.

## Layout

```
prompts/gate.md         the gate's system prompt
prompts/sort.md         the sorter's system prompt
src/index.ts            routing, origins, errors
src/gate.ts             /gate: the request to Claude and the server-side clamp
src/sort.ts             /sort: the request to Claude and the shared cache
src/claude.ts           one Messages API call with a JSON schema, via @anthropic-ai/sdk
src/quota.ts            the Quota Durable Object and the daily caps
src/validate.ts         request validation, installId, domain normalization
test/                   vitest tests with a mocked Anthropic API
scripts/smoke.mjs       wrangler dev end-to-end check against scripts/mock-anthropic.mjs
```
