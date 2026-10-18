# The Gatekeeper account: contract version 1

The API between the relay's account and its devices (the extension in Brave, Chrome and Safari, the Mac app, later the iPhone), for 0.3.0. It follows the design approved on 2026-10-18 ([one Gatekeeper per person](../../brain/outputs/html/2026-10-17-gatekeeper-one-per-person.html), and the "One Gatekeeper per person" section of `~/brain/knowledge/notes/gatekeeper.md`).

Status: **draft 2, 2026-10-18** (draft 2 adds `today` for the Mac, `device_removed`, the `exam.start` name, two device-only fields, and how to run it locally), written by the relay session. It is implemented on the relay's `account` branch and has not been deployed. The extension and the Mac app build against it; send changes to the relay session before building around them.

## In one paragraph

Each person has one account: a Durable Object on the relay running the extension's engine, unchanged. It holds the only true copy of the state. A device keeps a copy and its own engine, decides every page from that copy, and syncs about every 30 seconds, and at once after something the user does. A sync sends **spans** (real time spent in front of watched things) and **requests** (what the user did), and gets back the account's **copy** and one **result** per request. Requests that need Claude (the gate, the chat, a loosening) are answered by the account itself, inside the sync. A new device joins with a 6-digit code shown on a device already in the account.

## Basics

- Base: the relay's address, as today (`https://gatekeeper-relay.mvallot22.workers.dev` in production; `http://127.0.0.1:8787` under `wrangler dev`).
- Every endpoint is `POST` with a JSON body, under `/account/`. Every body carries `"v": 1` (the contract version); every answer carries `"v": 1` too. The account reads older versions for at least three months after a newer one ships.
- Authenticated endpoints take `Authorization: Bearer <token>`. The token is returned once, when a device is created or joins, and is the device's only secret. Keep it in the extension's local storage, or the Mac's Keychain. A removed device's token stops working at once.
- Times are milliseconds since the epoch, on the sender's clock. The account converts device times to its own clock (see Clocks).
- Errors are JSON `{ "v": 1, "error": "<code>" }` with a 4xx or 5xx status:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request`, `bad_version`, `invalid_<field>` | The request is malformed. Nothing changed. |
| 401 | `bad_token` | No token, a malformed one, or a wrong key. Ask the user to join again. |
| 401 | `device_removed` | This device was removed from the account (Settings › Devices on another device). Back to the code screen. |
| 404 | `bad_code` | The code is wrong, used, or expired. |
| 410 | `account_deleted` | The account was deleted. Keep the copy and carry on alone. |
| 429 | `daily_limit` (with `scope`, `resets`) or `too_many_codes` | Not now. Try again later; nothing was approved. |
| 502, 503 | `upstream_error`, `upstream_busy` | Claude could not be reached. Only in a request's result, never for the whole sync. |

## Create an account: `POST /account/create`

The first install of anything, when the welcome is finished. No question is asked.

```json
{ "v": 1, "device": { "name": "Brave on Mac", "kind": "extension" }, "tz": "America/New_York", "now": 1760800000000, "state": { ...the device's engine state... } }
```

- `device.kind` is `extension`, `mac` or `phone`. `name` is shown in the device list, up to 60 characters.
- `tz` is the user's IANA time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). The account needs it, because the day starts at 4:00 local time and the relay runs in UTC.
- `state` is optional: the device's whole engine state, as `upgrade()` leaves it. Without it, the account starts from `initialState()`.

→ `{ "v": 1, "accountId": "…uuid…", "device": { "id": "…uuid…", "token": "gk1.…" }, "copy": { ... }, "version": 1, "serverNow": 1760800000123 }`

New accounts are limited to 20 a day per network address (429 `daily_limit`, scope `ip`).

The `accountId` is also the state's `installId`, so `/sort` and `/judge`, which devices still call directly, count against the account's daily allowance.

## Add a device: `POST /account/code` (authenticated)

Settings › Add a device, on a device already in the account.

`{ "v": 1 }` → `{ "v": 1, "code": "493027", "expiresAt": 1760800600000 }`

The code is 6 digits, works for 10 minutes, and works only once. Asking again replaces the earlier code.

## Join with a code: `POST /account/join`

The welcome on a new device: "Already use Gatekeeper? Enter the code from your other device."

```json
{ "v": 1, "code": "493027", "device": { "name": "Safari on Mac", "kind": "extension" }, "tz": "America/New_York", "now": 1760800100000, "state": { ...this device's state, if it has one... } }
```

→ `{ "v": 1, "accountId": "…", "device": { "id": "…", "token": "gk1.…" }, "copy": { ... }, "version": 7, "serverNow": …, "merged": { "rulesDiffer": true, "lostRules": { ...the joining device's rules... } } }`

What happens when two Gatekeepers meet (section 2 of the design). The result is never looser than the stricter of the two, and nothing is lost:

- **Rules:** the account's set stays whole. If the joining device's rules differ, `merged.rulesDiffer` is true and its rules come back in `merged.lostRules`; the account also keeps them in its history for 30 days. To offer "Use this device's rules instead", send them as a `propose` request (below). That is a rule change, so the tighter parts apply at once and the looser parts need the agent.
- **Today's minutes:** added together, per bucket (each kind, each site's own limit, each video rule), if both are on the same day.
- **Exam mode:** if either side has it on, it stays on until the later end.
- **Passes and cooldowns:** the account's are kept. A pass on the joining side ends.
- **A waiting loosening:** the account's waits as before. The joining one is dropped; the user asks again.
- **Chat and the history log:** interleaved by time. The chat keeps its last 50 turns, and the log its last 300 entries. Finished days the account doesn't have are added.
- **Consent:** the account's. A device that joins shows Claude help as the account has it.

Wrong codes are limited per network address (30 a day), so 6 digits can't be guessed.

## Sync: `POST /account/sync` (authenticated)

About every 30 seconds while the device is in use, and at once after something the user does.

```json
{
  "v": 1,
  "now": 1760800130000,
  "tz": "America/New_York",
  "have": 7,
  "spans": [ { "seq": 41, "from": 1760800100000, "to": 1760800105000, "buckets": ["social"] } ],
  "requests": [ { "id": "r-1760800130000-1", "type": "talk", "url": "https://www.youtube.com/", "message": "lecture 6 recording for 15.390" } ]
}
```

→

```json
{
  "v": 1, "version": 9, "serverNow": 1760800130250, "spansUpTo": 41,
  "copy": { ... } ,
  "results": [ { "id": "r-1760800130000-1", "decision": "allow", "minutes": 5, "site": "youtube.com", "reply": "Five minutes for the recording." } ]
}
```

- `want: ["today"]` asks for `today` (below) in the answer. A device of kind `mac` always gets it, in the join answer too.
- `have` is the `version` of the copy the device holds. If nothing changed and there were no spans or requests, the answer is `{ "v": 1, "version": 7, "serverNow": …, "unchanged": true }`, without a copy.
- `spansUpTo` is the highest span `seq` the account has counted. The device drops the spans up to it and resends the rest at the next sync. Resending a span is harmless (see Spans).
- `results` come in the order of `requests`. A request the account has already answered (the same `id`, within the last 200) gets its first answer again, so a retry never counts twice.
- After a sync the device replaces its copy with `copy`, keeps its device-only fields (below), and re-applies the spans it hasn't had counted yet.

### Spans: counting time across devices

A span says "this was in front, from this moment to that one": `{ seq, from, to, buckets }`.

- `buckets` are the engine's buckets that the device's copy counted for that moment: the kind (`"social"`), a site's own limit (`"s:lequipe.fr"`), a video rule (`"v:<id>"`). When a site's own limit also counts against its kind, the site comes first: `["s:instagram.com", "social"]`. A span with `[]` says only "Gatekeeper was running"; passes run down on it.
- A device sends a span for every period it was running, `[]` included. Ticks next to each other can be sent as one span.
- The account counts real time once: for each bucket it keeps the union of the spans it has seen today, and the bucket's seconds are the length of that union. YouTube in front in two browsers at the same moment counts once. YouTube playing in Safari while Instagram is in front in Brave counts both. A span sent twice, or late, changes nothing it shouldn't.
- Passes run down by real time on the union of all spans, so a 5-minute pass lasts 5 minutes with two browsers open.
- Only the part of a span inside the account's current day counts. Spans older than 26 hours, or ending after the account's clock, are cut.
- `seq` grows by one per span on each device and never goes back.

### Clocks

Every sync carries the device's `now`. The account converts a span by the difference between its clock and `now`, so a device clock that is wrong, set back or set forward changes nothing. The account's own clock is the relay's, and only goes forward.

### Requests

One per thing the user did. Each has a unique `id`, chosen by the device, and a `type`. They are the extension's own handlers, run by the account through the same engine functions:

| `type` | Fields | Engine | Result |
| --- | --- | --- | --- |
| `setup` | `kinds`, `goal` | `completeSetup` | `{ now, later, from }` |
| `propose` | `rules`, `goal?`, `undoable?` | `proposeRules` (+ `setGoal`) | `{ now, later, from, needsOk, refused }` |
| `goal` | `goal` | `setGoal` | `{ ok }` |
| `consent` | `help?`, `talk?`, `sorting?`, `chat?`, `judge?`, `seeAll?` | `setHelp`, `setTalk`, `setSorting`, `setConsent` | the switches as they are now |
| `talk` | `url`, `message` | `gateRequest`, Claude's `/gate`, `applyGateAnswer` | the gate's answer, as the extension's `talk` returns it |
| `chat` | `message` | `chatRequest`, Claude's `/rules`, `chatPreview`, `recordChatAnswer` | `{ ok }` or `{ refused }` or `{ failed }`; the card is in the copy's `thread` |
| `applyCard` | | `applyCard` | the outcome, or `{ refused }` |
| `dropCard` | | `dropCard` | `{ ok }` |
| `forgetThread` | | `forgetThread` | `{ ok }` |
| `startExam` | `until`, `goal`, `source` | `startExam` | `{ ok, refused, exam }` |
| `endExam` | | `endExam` | `{ refused, until, needsOk }` |
| `loosen` | `message`, `examAt?` | `loosenRequest`, Claude's `/loosen`, `applyLoosenAnswer` | the agent's answer, or `{ decision: "unavailable", error }` |
| `dropLoosen` | | `dropLoosen` | `{ ok }` |
| `watch` / `endWatch` / `watchShown` | `goal` for `watch` | `startWatch`, `endWatch`, `markWatchShown` | `{ ok }` |
| `dismissOffer` | `offer` | `dismissOffer` | `{ ok }` |
| `noteGate` | | `noteGate` | `{ ok }` |
| `sorted` | `domain`, `kind` | `recordSort` | `{ ok }` |
| `judged` | `key`, `rule`, `by` | `recordJudgment` | `{ ok }` |
| `calendar` | `events: [{ title, start }]`, from 2 days ago to 14 days ahead, at most 20 (what the engine keeps) | the account keeps the events, never the link | `{ ok }` |

- `talk` sends a page's `url`. Send only the scheme and host (`https://www.youtube.com/`); the gate needs nothing more. A YouTube video's address is never needed.
- `exam.start` is accepted as another name for `startExam` (the Mac's name for it in the native-messaging contract).
- The Mac app may send only `startExam`, plus the requests every device may send that tighten or say nothing (`noteGate`). Anything that loosens from the Mac is refused with `{ refused: "mac_cannot_loosen" }`, as in the native-messaging contract today.
- An unknown `type` gets `{ "refused": "unknown_type" }`; the device should show "Update Gatekeeper here".
- Claude's answers count against the account's daily allowance, not each device's.

### The copy, and the device's own fields

`copy` is the engine state as the account holds it, minus the fields that stay on each device. The device keeps its own values for these:

- `clock`: each device guards its own clock.
- `calendar`: the link stays where it was pasted. Only `calendar` requests' events reach the account, which keeps them as `calendar.events`.
- `judging`, `unknown`: work in flight on this device.
- `sorting`: whether this browser can see every site.
- `withheld`: which sites this browser can't see.
- `offersDismissed`: exam offers dismissed on this device.

### Today, ready-made: `today`

For a device that can't run the engine (the Mac app), the join and sync answers carry `today`: `engine.snapshot(state, serverNow)` without `pages`, `extensionId` and `base`. It has the native-messaging contract v1 shape: `{ type, v, at, reopensAt, kinds: [{ kind, label, short, minutes, left, status, fraction, exam }], sites, goal, waiting, exam: { until, goal }, watch }`. An `unchanged` answer has no `today`; keep the last one.

Everything else (rules, pending, exam mode, usage, passes, cooldowns, consent, thread, log, history, sorted, judged, loosen) is the account's.

## Devices: `POST /account/devices`, `/account/remove`, `/account/leave` (authenticated)

- `devices` → `{ "v": 1, "devices": [ { "id", "name", "kind", "joinedAt", "seenAt", "self": true|false } ] }`
- `remove` `{ "deviceId" }` → `{ "v": 1, "ok": true }`. The removed device's token stops working (a lost laptop). A device can't remove itself; it leaves.
- `leave` → `{ "v": 1, "ok": true, "copy": { ... } }`. This device leaves. It keeps the copy and carries on alone; leaving loosens nothing. The last device leaving deletes the account.

## Delete and export (authenticated)

- `delete` → `{ "v": 1, "ok": true }`. Everything the account holds is deleted on the relay at once, and every device's token stops working. Each device keeps its own copy and carries on alone.
- `export` → `{ "v": 1, "account": { "accountId", "createdAt", "tz", "devices": [...] }, "state": { ... }, "lostRules": [ ... ] }`: everything the account holds, for "Get a copy of my data". Device keys are never included.

## What the relay stores, per account

The engine state (rules, goal, today's minutes, passes and cooldowns, 30 days of history, the log of 300 entries, the last 50 chat turns, exam mode, consent, the loosening and its reasons, sorted sites and judged videos), the union of today's spans per bucket, the time zone, the device list (name, kind, dates, and a hash of each key), the calendar events the device sent (titles and times, 14 days ahead at most), and the rules that lost a merge, for 30 days. Never page addresses, page content or the calendar link.

## Not in version 1

- Email sign-in. It arrives with the domain. Accounts made with a code are then asked to add an email; nothing moves.
- The iPhone's coarse spans ("Social passed 5 minutes").
- The Mac's list of apps exam mode hides. It stays a Mac setting.
- Pushing changes to devices. Devices pull every 30 seconds.

## Running it locally

On the relay's `account` branch (worktree `~/gatekeeper-relay-0.3`):

```
npm ci
npm run dev:account
```

This starts the relay on `http://127.0.0.1:8787` (or `$PORT`) under `wrangler dev`, with a fake Claude, so no key is needed and nothing leaves the machine. The fake Claude allows a gate message that mentions a lecture, asks back on one about class, and denies everything else. In the chat it answers "limit lequipe" with a 15-minute site limit. State is kept in `.wrangler/account-dev`; delete that folder to start over. Never point a device at the live relay for this; `/account/*` isn't deployed there.

