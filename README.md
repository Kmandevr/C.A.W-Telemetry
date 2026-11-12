# C.A.W-Telemetry

Everything C.A.W collects, in the open. This repository holds the anonymous beta telemetry from the [C.A.W](https://github.com/Kmandevr/C.A.W) app, the weekly summaries made from it, beta feedback (as Issues), and the small relay that receives them.

C.A.W collects **nothing about you**: no names, accounts, projects, audio, MIDI, file paths, location or any ID that follows you. It collects how well the app runs on your device (device specs, CPU load, dropouts, frame times, stress-test results), which built-in features are used, and error locations in C.A.W's own code. The full list is in [PRIVACY.md](PRIVACY.md); the exact format is in [PLAN.md](PLAN.md#report-schema-v1).

## What's here

| Path | What it is |
|---|---|
| `data/<xx>/<receipt>.json` | One file per report, exactly as published. `<receipt>` is a random ID your device made for that one report; the app's **Settings → Privacy → My data** lists yours, with links. |
| `summaries/<year>-W<week>.md` | A weekly summary: devices, performance, what holds them back, errors. |
| Issues labelled `beta-feedback` | Feedback sent from the app (bug, idea, confusing, praise). |
| `src/`, `schema/`, `test/`, `wrangler.toml` | The relay: a Cloudflare Worker on the free plan. |
| [PLAN.md](PLAN.md) | How it all works, the contract with the app, setup and limits. |
| [PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md) | The beta's privacy policy and terms. |

## Deleting your data

In the app: **Settings → Privacy → My data → Delete my data**. Your device holds a secret key for each report; only that key can delete it. Deleted files are removed from `data/` within about an hour. Git history and copies others have already downloaded can't be recalled; see [PRIVACY.md](PRIVACY.md).

## Licence

Code: Apache-2.0, like C.A.W. Data and summaries: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication).
