# Plan: the C.A.W beta relay and data

Owner decisions of 2026-11-12, as built. The C.A.W app's side is built in `Kmandevr/C.A.W` by a separate session; **this file and that repo's `docs/decisions.md` hold the shared contract**. Change it only with the owner, in both places.

## Decisions (owner, 2026-11-12)

- **Purpose:** device specs and how well C.A.W runs on them, so the owner can make design decisions. Nothing about the user is collected.
- **Defaults:** beta builds send telemetry by default; release builds don't, and ask. Switching from beta to release turns it off and asks once. First run shows the privacy policy and terms; continuing accepts them. It can be turned off at any time in Settings → Privacy.
- **Full transparency:** every report is published in this public repository. Feedback is posted as public Issues here. Optional contact emails are never published.
- **No user ID:** each report has a fresh random receipt (128 bits) made on the device; nothing links reports to each other or to a person. Users find their own reports through the app's "My data".
- **Zero cost:** Cloudflare Workers Free plan, no payment method; Actions only in public repos (free standard runners).
- **Everything collected or used that isn't C.A.W's code** lives in this repository.

## How it works

```
app ──HTTPS──▶ relay (Cloudflare Worker, free) ──▶ D1 buffer ──hourly cron──▶ this repo: data/, summaries/
                     └──────────────────────────────── feedback ──▶ Issues here (contact email kept in D1 only)
```

- **Relay:** `https://caw-telemetry.kmandevr.workers.dev` (Worker `caw-telemetry`, account "Kmandevr@gmail.com's Account"). Code in `src/`, tables in `schema/d1.sql`, config in `wrangler.toml`.
- **D1 database:** `caw-telemetry` (`a724d0b8-8b85-44c8-96d1-a24a8a89c7e6`). Holds reports until they're published (full JSON kept 35 days, then only the receipt, its delete hash and status), the feedback queue, contact emails (180 days), and daily counters.
- **Hourly cron (`17 * * * *`):** retries queued feedback, publishes new reports and deletions (up to 3 commits of 50 files each), and at 03:17 UTC prunes old rows; on Mondays at 03:17 it commits `summaries/<ISO week>.md` for the week just ended.
- **No IP addresses are stored.** Per-sender limits count a SHA-256 of the address with a salt made fresh each UTC day and deleted the next day.

## The contract with the app

Every request sends `X-CAW-App-Key: caw-beta-1`. It is **not a secret** (it ships in the app); it only blocks casual spam. A new build can get a new key by adding it to `APP_KEYS`.

| Request | Body | Responses |
|---|---|---|
| `POST /v1/report` | [schema v1](#report-schema-v1), at most 8 KB | `202 {"status":"queued"}`; `400 {"error":...}` (bad schema, or receipt already used); `413` too large; `429` sender limit, `503` daily capacity, both with `Retry-After`: keep it queued |
| `GET /v1/report/<receipt>` | none | `200` the published JSON; `202 {"status":"queued"}` not yet published; `404` unknown or deleted |
| `POST /v1/delete` | `{"items":[{"receipt":"<32 hex>","deleteKey":"<64 hex>"}]}`, up to 100 | `202 {"deleted":<n>}`; the files leave `data/` at the next hourly run |
| `POST /v1/feedback` | below, at most 32 KB | `201 {"issue":"<url>"}`; `202 {"status":"queued"}` when GitHub is slow (posted within the hour); `400`/`413`/`429`/`503` as above |
| `GET /` | none | `200 {"service":"caw-telemetry relay","schema":1}` (health check, no key needed) |
| `GET /v1/status` | none | `200 {"github":"ok","repo":...,"canWrite":true,"reportsWaiting":n,"feedbackWaiting":n}`, or `{"github":"no token set"}` / `"token cannot see the repository"`: for maintainers; never shows the token |

Any other error, including the relay's own, is `503` with `Retry-After`; nothing internal is echoed.

**Limits:** per sender per UTC day: 10 reports, 5 feedback posts, 200 lookups. Whole relay per day: 5,000 reports, 300 feedback posts, 10,000 lookups. The app sends at most one report a day.

### Report schema v1

The relay keeps only these fields (unknown ones are dropped, wrong types are a `400`) and rounds as noted even if the app didn't. `deleteHash` is stored privately and never published.

```
{
  "schema": 1,
  "receipt": "<32 lowercase hex: 128 random bits from the device>",
  "deleteHash": "<64 lowercase hex: SHA-256 of the 32 raw bytes of a random delete key the device keeps>",
  "channel": "beta" | "release",
  "day": "YYYY-MM-DD",
  "app": { "version": "1.0.0-beta.1", "engineVersion": "<letters, digits, . + ->", "capiVersion": <int> },
  "device": {
    "platform": "android" | "windows" | "linux",
    "osVersion": "<major version, digits only>",
    "cpu": "<printable ASCII, cut to 80>",
    "cores": { "big": <int>, "little": <int>, "other": <int> },
    "maxClockMHz": [<up to 4 numbers, rounded to 100>],
    "ramGB": <whole GB>,
    "gpu": "<printable ASCII, cut to 80>",
    "refreshHz": <int>,
    "audio": { "backend": "<a-z 0-9 _>", "exclusive": <bool>, "lowLatency": <bool>, "bufferFrames": <int>, "sampleRate": <int> },
    "profile": "full" | "balanced" | "lightweight" | "minimal",
    "eco": <bool>
  },
  "perf": {
    "cpuLoadHistogram": [<exactly 10 numbers 0..1, rounded to 0.01: share of playing time in each 10% load bucket>],
    "dropouts": <int>,
    "worstCallbackPct": <rounded to 5>,
    "frames": { "p50ms": <0.1 ms>, "p99ms": <0.1 ms>, "slowPct": <int> },
    "startupMs": <rounded to 50>,
    "thermalEvents": <int>, "batterySaverMinutes": <int>,
    "schedHint": "on" | "off" | "unsupported",
    "callbackCoreType": "big" | "little" | "other" | "unknown"
  },
  "usage": {
    "minutesOpen": <rounded to 5>, "minutesPlaying": <rounded to 5>,
    "screens": { "<id: a-z, 0-9, _ . ->": <minutes, rounded to 5> },
    "builtins": { "<org.caw.* id or a built-in effect id such as reverb.pro>": <uses> },
    "projectSize": { "tracks": "1-4" | "5-8" | "9-16" | "17-32" | "33+", "clips": "1-10" | "11-50" | "51-200" | "201+" }
  },
  "stress": null | {
    "version": 1,
    "tiers": { "normal": "comfortable" | "tight" | "over", "heavy": <same>, "extreme": <same> },
    "limits": { "tracks": <int>, "voices": <int>, "effects": <int> },
    "scenarios": { "<scenario id>": { "meanPct": <int>, "p99Pct": <int>, "worstPct": <int>, "dropouts": <int> } },
    "topCosts": [ { "component": "<built-in id>", "pct": <int> } ]   // up to 10
  },
  "errors": [ { "type": "<exception type>", "where": "<C.A.W source location>", "count": <int> } ]  // up to 20
}
```

- Ids that don't match the shapes above are counted as `"other"`, so a user's own component or project names can never be published.
- `errors[].where` must be C.A.W's own source, relative: `lib/…`, `src/…`, `engine/…`, `app/…`, `platform/…`, `include/…` or `package:caw/…`, then `:<line>`. Absolute paths (which could hold a username) are rejected.

### Feedback

```
{
  "schema": 1,
  "kind": "bug" | "idea" | "confusing" | "praise",
  "text": "<1..5000 characters>",
  "appVersion": "1.0.0-beta.1",
  "platform": "android" | "windows" | "linux",
  "attachments": { "device": <as report.device>?, "stress": <as report.stress>?, "errors": <as report.errors>? },
  "contact": "<email>"?
}
```

Each becomes an Issue here titled `[<kind>] <first line>`, labelled `beta-feedback` and `fb-<kind>`. The text is shown in a code block, so it can't mention people, embed images or run markdown. Attachments are in collapsed sections. The contact email is kept privately in D1 for 180 days; the owner reads it in the Cloudflare dashboard (Workers & Pages → D1 → caw-telemetry → Console: `SELECT * FROM contacts`).

## Setup (once, owner)

1. ~~Cloudflare: Worker, D1 database and hourly cron~~ (done 2026-11-12, through the Cloudflare connector).
2. ~~Create this repository: public, `Kmandevr/C.A.W-Telemetry`~~ (done 2026-11-12).
3. Create one fine-grained GitHub token (github.com → Settings → Developer settings → Fine-grained tokens → Generate):
   - Resource owner: Kmandevr. Repository access: **Only select repositories → C.A.W-Telemetry**.
   - Permissions: **Contents: Read and write**, **Issues: Read and write** (Metadata: Read is added automatically).
   - Expiry: the longest you're comfortable with; renew it before it ends (the relay's commits stop when it expires).
4. ~~Give it to the relay~~ (done 2026-11-12): Cloudflare dashboard → Workers & Pages → `caw-telemetry` → Settings → Variables and Secrets → Add → type **Secret**, name `Github_Token` (the relay also reads `GITHUB_TOKEN`), paste the token → Deploy. `GET /v1/status` confirmed it can write to this repository.
   - **Renewing:** when the token nears expiry, make a new one the same way and replace the secret's value; nothing else changes.

Nobody else ever sees the token: it lives only in Cloudflare's secret store.

## Free-plan limits (Cloudflare docs, read 2026-11-12)

| Limit (Workers Free) | Value | This relay at its caps |
|---|---|---|
| Requests | 100,000 a day | up to ~15,300 |
| CPU per invocation (cron included) | 10 ms | validation and small commits only |
| Subrequests per invocation | 50 | at most 30 per cron run |
| Cron Triggers per account | 5 | 1 |
| D1 rows written | 100,000 a day | about 50,000 worst case |
| D1 rows read | 5 million a day | far below |
| D1 storage | 5 GB | old report bodies pruned after 35 days |

Over a limit, the free plan fails requests until midnight UTC; it never bills ([D1 change, 2026-09-01](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). The app keeps anything refused and retries the next day. The weekly summary shows usage against the caps. If the beta outgrows them, don't upgrade: ask the owner (options: sample reports, send weekly, drop fields).

## Tests

`npm test` (Node 22.5+; no dependencies): the schema allow-list, every endpoint against SQLite standing in for D1, publishing, deletion, feedback and the weekly summary against a fake GitHub, and a check that no IP address is stored.

## Deploying changes

The Worker was deployed through Cloudflare's API (the claude.ai Cloudflare connector). Later options, all free: the same connector from a Claude session, or `npx wrangler deploy` with a Cloudflare API token. Keep the Worker's bindings as in `wrangler.toml`, and never put the GitHub token in any file.
