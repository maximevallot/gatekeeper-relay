# gatekeeper-relay

The server that stands between the Gatekeeper browser extension and Claude. It holds the Anthropic API key as a Cloudflare secret, so the key never ships inside the extension, and it enforces the limits that keep a student, or someone abusing the endpoint, from spending more than a few cents a day.

It is a Cloudflare Worker in TypeScript. It has five endpoints, all `POST` with a JSON body (plus `GET /privacy`, the privacy policy, and `HEAD /`, a 204 whose `Date` header the extension reads after the computer's clock jumps; it carries nothing and counts against no cap), and one model: Claude Haiku 5.5 (`claude-haiku-5-5`, the newest Haiku as of 2026-10-16, $0.10 per million input tokens and $0.50 per million output tokens).

Milestone 1 of Gatekeeper makes no network calls. Milestone 2 uses `/gate` (the gate's single box for a real need) and `/sort` (sorting sites the extension does not know into a kind). Milestone 3 adds `/rules` (the rules chat), `/judge` (YouTube video rules) and `/loosen` (the agent that holds the key to loosening); its design is `~/brain/outputs/html/2026-10-16-gatekeeper-rules-by-talking.html`. The "one Gatekeeper" plan (`~/brain/outputs/html/2026-10-17-gatekeeper-one-model.html`) taught `/rules`, `/gate` and `/loosen` about exam mode and the local time, and limited the chat to the extension's five kinds.

### Shared fields: `now` and `exam`

`/rules`, `/gate` and `/loosen` also take two optional fields:

- `now`: the student's local time with its offset, such as `"2026-10-17T14:05:00-04:00"`. Without it, the prompts get the UTC date.
- `exam`: `{ "until": "2026-10-21T08:30:00-04:00", "goal": "Midterm 15.425" }` while exam mode is on, `null` or absent when it is off. `until` uses the same format as `now`. An optional `examAt` (`at` is accepted too) is the exam's own time: the start of the latest exam event in the calendar that falls inside exam mode and has begun, or null. Same format.

A malformed `now` or `exam` is a 400 (`invalid_now`, `invalid_exam`). Fields the relay does not know are ignored, so the extension can send new ones before the relay is redeployed.

Exam mode, as Maxime decided it on 2026-10-17: it closes every site except study sites until its end; the gate gives a short pass only for a page that serves the exam; ending it early goes through `/loosen`, where a yes ends it at once if the exam is over and otherwise the next morning.

## The account (0.3.0, branch `account`, not deployed)

One Gatekeeper per person, as Maxime approved on 2026-10-18 ([the design](../brain/outputs/html/2026-10-17-gatekeeper-one-per-person.html)). Each person's account is a Durable Object (`Account`) running the extension's engine unchanged. It holds the only true copy of the rules, today's minutes, exam mode, the chat and the history. Browsers and the Mac app keep a copy and sync about every 30 seconds. The API is [docs/account-contract.md](docs/account-contract.md).

- **The engine** is vendored in `vendor/engine/` from `~/gatekeeper-app/extension/engine` at a pinned commit (`vendor/engine/SOURCE.md`); `scripts/vendor-engine.sh <commit>` refreshes it. Never edit it here.
- **Time zone:** the engine reads local time and Workers run in UTC, so every engine call runs inside `withTimeZone` ([src/account/tz.ts](src/account/tz.ts)), which makes the Date methods it uses read the account's time zone for that synchronous call.
- **Spans** ([src/account/spans.ts](src/account/spans.ts)): time from every device counts once. Each bucket's seconds are the length of the union of today's spans, and passes run down on the union of all spans.
- **Joining** ([src/account/merge.ts](src/account/merge.ts)): the account's rules stay whole, today's minutes are added, the later exam end wins, the account's passes and loosening stay, and chat and log are interleaved. This stands in until the engine has its own `join`.
- **Requests** ([src/account/requests.ts](src/account/requests.ts)) are the extension's background handlers run on the account. The gate, the chat and a loosening ask Claude from inside the account, under one allowance per account. The Mac may only start exam mode.
- **Codes** (`Pairing`): 6 digits, 10 minutes, one use, one object per code. Tries are limited to 30 a day per network address, and new accounts to 20.
- `npm run smoke:account` runs it end to end under `wrangler dev` with Brave, Safari and the Mac simulated (22 checks).
- The 0.3.0 privacy policy is drafted in `pages/privacy-0.3.0-draft.html`. `/privacy` still serves 0.1.1, unchanged.

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
- The server has the last word on minutes: a pass is at least 1 and at most `MAX_PASS_MINUTES` (10), whatever the model says. In exam mode the cap is `MAX_EXAM_PASS_MINUTES` (5), and the prompt allows a pass only for a page that serves the exam ("what is ROCE").
- If the model refuses, or returns something that is not one of the three decisions, the answer is `deny` with 0 minutes.
- `deadlines` is up to 10 items, each `{title, due}` or a plain string: the events from the student's calendar link for the next 48 hours. The prompt tells the model it cannot know whether a deadline was submitted, so it never calls one overdue. (On 14 October the old gate told Maxime a worksheet was overdue that Anders had already submitted for the team.)
- Limits: `message` 1 to 500 characters, `goal` up to 300, `minutesUsed` and `budget` 0 to 1440, `kind` one of the eight kinds below, or `"site"` for a site with its own limit (then `minutesUsed` and `budget` are that site's own).

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

### `POST /rules`

The rules chat on the extension's rules page: the student's words in, a list of rule changes out. The extension applies nothing by itself; it shows the changes as a card and the student presses Apply, and its engine decides what applies now and what waits for the next morning.

```json
{
  "installId": "…", "message": "block YouTube videos about video games but keep educational ones",
  "today": "2026-10-19", "now": "2026-10-19T14:05:00-04:00", "exam": null,
  "history": [{ "role": "user" | "gatekeeper", "text": "…" }],
  "rules": { "kinds": { "video": 20 }, "sites": { "openfront.io": "games" },
             "videos": [{ "id": "v1", "site": "youtube.com", "about": "…", "except": "…", "minutes": 0 }], "dayStart": 4 }
}
→ { "reply": "…", "question": null, "diff": [ { "op": "addVideo", "site": "youtube.com", "about": "…", "except": "…", "minutes": null, "words": { "match": […], "except": […] } } ] }
```

- Operations: `budget` {kind, minutes}, `unwatch` {kind}, `site` {domain, kind}, `unsite` {domain}, `addVideo`, `videoBudget` {id, minutes}, `dropVideo` {id}, `dayStart` {hour}, `examStart` {until, goal}, `examEnd` {}, `siteLimit` {domain, minutes}, `dropSiteLimit` {domain}. A video rule's `minutes` is 0 (closed), a number (its own daily minutes) or `null` (free).
- `loosenLocked: true` (optional) says an earlier no holds every loosening until the morning. The relay then drops every change that would give more time and replies "I said no to a loosening today, so that waits: ask again after 4:00." (QA round 3, N1).
- `examStart` starts exam mode, or extends it while it is on. Its `at` is the exam's own time when the student says it ("exam thursday 9am"), or null; the extension keeps it, and exam mode can end at once only after it. `examEnd` asks to end it early; the extension turns it into a loosening request through `/loosen`.
- `siteLimit` {domain, minutes} gives one site its own limit, whatever its kind: daily minutes (0 closes it all day), or `null` for "closed only in exam mode". `dropSiteLimit` {domain} removes it. The rules state may carry `siteLimits: { "lequipe.fr": 15 }`. These names were agreed with the extension on 2026-10-17.
- The chat chooses a stated default rather than asking how to model a rule: "i want to put a limit on the site lequipe" gets `siteLimit` lequipe.fr 15 and the reply "lequipe.fr: 15 minutes a day." It asks only when a request cannot be carried out (an unknown site, exam mode with no end time).
- "lequipe should be blocked when in exam mode" needs no change: exam mode already closes every site that is not for study.
- The server checks every operation (`enforceRules` in [src/rules.ts](src/rules.ts)): the five kinds the extension can limit (social, video, games, news, shopping) and no others, an `examStart` time with an offset, after `now`, at most 30 days ahead and never earlier than the current end, `examEnd` only while exam mode is on, one exam change per card, `dropSiteLimit` only for a site that has its own limit, minutes clamped to 0–1440, video rules only on youtube.com and only for ids the student has, domains normalized, at most 10 operations. A `question` replaces any change. A refusal or junk gets a plain reply and no change.
- No usage is sent: no minutes used, no passes.
- Limits: `message` 1–500 characters, `history` up to 6 turns, up to 100 own sites and 20 video rules; the body may be up to 24 KB (8 KB for the other endpoints).

### `POST /loosen`

The agent that holds the key to loosening: a request to loosen a rule or end exam mode early, with the student's reason.

```json
{ "installId": "…", "kind": "exam", "goal": "Midterm 15.425", "changes": ["End exam mode early"],
  "asked": "", "message": "I just took the midterm", "now": "…", "exam": { "until": "…", "goal": "…" } }
→ { "decision": "allow", "when": "now", "reply": "Exam mode ends now." }
```

- `kind` is `rules` or `exam`. `decision` is `allow`, `deny` or `ask`; `ask` comes at most once (with `asked` set, an ask counts as no).
- `when` is `"now"` or `"morning"` with `allow`, `null` otherwise. Every yes applies the next morning, except ending exam mode once the exam can be over: `"now"` is allowed only when `exam.examAt` is known and the relay's own clock (never the device's) is past it (`canEndNow` in [src/loosen.ts](src/loosen.ts)); the extension applies the same rule. A student who says the exam is over gets a yes, never a flat no: "now" when the exam's time is known and past, "tomorrow morning" otherwise (QA round 3, N2). An extension that gets no `when` (an older relay) should treat a yes as `"morning"`.

### `POST /judge`

Which of the student's video rules one YouTube video falls under.

```json
{ "installId": "…", "site": "youtube.com", "title": "I played Minecraft for 100 days", "channel": "SomeGamer",
  "rules": [{ "id": "v1", "about": "video games: …", "except": "educational videos about games" }] }
→ { "rule": "v1" | null, "judged": true }
```

- `judged: false` means the model refused or named no rule it was sent; the extension then judges by the rule's word lists on the device.
- Nothing is cached or stored: a list of video titles says too much about a person. The extension keeps the answer per video ID.
- The video's address is never sent; the extension gets the title and channel from YouTube's oEmbed address.

### Errors

Every error is JSON `{ "error": "<code>" }`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_install_id`, `invalid_kind`, `missing_message`, `message_too_long`, `invalid_json`, `body_too_large`, … | The request is malformed. No Claude call was made. |
| 403 | `origin_not_allowed` | The request came from a web page, not the extension. |
| 429 | `daily_limit` with `scope`: `install`, `ip` or `global`, and `resets` (ISO time) | A daily cap is reached: "not now". Resets at 00:00 UTC (20:00 in Boston during daylight time); a `Retry-After` header gives the seconds. |
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
| `MAX_RULES_PER_INSTALL` | 40 | Rules chat messages per install: an allowance of its own, outside the install's shared caps (QA round 2 found the chat stopped after 8 or 9 messages when it shared them). |
| `MAX_LOOSEN_PER_INSTALL` | 10 | Requests to loosen a rule per install: an allowance of its own, so gate calls can never use up the agent. |
| `MAX_JUDGE_PER_INSTALL` | 150 | Videos judged per install: an allowance of its own, outside the install's shared caps, so watching YouTube does not use up the gate. Counts against the IP and global caps. |
| `ALLOWED_ORIGINS` | empty | Empty allows any `chrome-extension://` origin (Chrome and Brave). Set it to the extension's own origin once it has a fixed ID. |

`installId` must be a UUID. The extension makes one with `crypto.randomUUID()` on first run and keeps it in `chrome.storage.local`.

## Cost

Estimated from the prompt sizes; no real call has been made yet.

- A gate sends about 1,000 to 1,200 input tokens (the [gate prompt](prompts/gate.md) is about 3,300 characters, plus the context) and gets back about 50 tokens of JSON, plus whatever the model thinks at `effort: low`. Call it 1,200 in and 250 out: about $0.00025, so roughly 4,000 gates per dollar.
- A sort is about 600 in and 50 out: about $0.0001, once per domain for all users.
- A rules chat message is about 1,800 in (the prompt is about 5,000 characters, plus the rules) and 300 out: about $0.0003.
- A video judgment is about 500 in and 30 out: about $0.00006, so 150 videos, the daily allowance, cost about a cent.
- The first real calls should confirm this: the Anthropic Console shows token counts per request.

## Prompts

The prompts are plain Markdown files, bundled into the Worker as text:

- [prompts/gate.md](prompts/gate.md): the gate's rules, decisions and reply style.
- [prompts/sort.md](prompts/sort.md): the eight kinds with examples.
- [prompts/rules.md](prompts/rules.md): the rule model and the operations the chat may return.
- [prompts/judge.md](prompts/judge.md): judging one video against the student's video rules.

Editing a prompt needs only a redeploy. If you change the kinds or how sorting works, bump `CACHE_PREFIX` in [src/sort.ts](src/sort.ts) (`kind:v1:` to `kind:v2:`) so old answers are not reused.

What the person typed and the page title are wrapped in `<message>` and `<title>` tags, with any copy of those tags stripped out, and both prompts say to treat that text as data. The server-side clamp is the real protection: even a message that talks the model into anything gets at most `MAX_PASS_MINUTES`.

## Privacy

- The relay logs no request bodies. What a student types at the gate goes to the Anthropic API and nowhere else; Anthropic's commercial API terms govern what they keep.
- The sort cache stores only `domain → kind`. Page titles are sent to Claude and not stored.
- `/judge` stores and caches nothing; `/rules` stores nothing. Video titles, channels, rules and chat messages go to the Anthropic API and nowhere else.
- The public policy is [pages/privacy.html](pages/privacy.html), served at `/privacy`. Deploy it in the same deploy that adds or changes what an endpoint receives.
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
2. `npm test`: 125 vitest tests inside the Workers runtime (`@cloudflare/vitest-plugin`), with a mocked Anthropic API. They cover the request sent to Claude, the minute clamp, refusals and bad output, upstream failures, installId and field validation, every cap, the sort cache, origins, the rules chat and video judge (their checks on the model output, input validation and allowances), loosening, and exam mode across `/rules`, `/gate` and `/loosen`.
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

- The repository is on GitHub as the private https://github.com/maximevallot/gatekeeper-relay.

## Known limits

- **installIds are self-issued.** Anyone can make a UUID, so the per-install cap alone does not stop abuse; the per-IP cap and the global ceiling bound it. A signed install token issued by a `/register` endpoint would close this if it matters.
- **Sort answers are shared.** The first title sent for a domain shapes the answer every user gets for 90 days. The prompt says to judge the domain, not the page, and to ignore instructions in the title; a wrong kind can be fixed by deleting the KV key `kind:v1:<domain>` in the Cloudflare dashboard.
- **Students behind one NAT** share the per-IP cap of 300 calls a day. Raise `MAX_CALLS_PER_IP` if a campus network trips it.
- **No limit on passes per day.** The call cap bounds it at 60 tries; the extension can add its own rule if passes pile up.
- **Prompt caching is on, unmeasured.** Every system prompt is sent as a cached block, and a cache read counts as a tenth of a token against the caps, as it is billed. Whether a prompt is long enough for Haiku 5.5 to cache it has not been checked against real usage numbers; a prompt that is too short simply isn't cached.

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
