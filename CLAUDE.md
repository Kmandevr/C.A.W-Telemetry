# C.A.W-Telemetry

The public home of everything [C.A.W](https://github.com/Kmandevr/C.A.W) collects or uses that isn't C.A.W's own code: anonymous beta telemetry (`data/`), weekly summaries (`summaries/`), beta feedback (Issues), the privacy policy and terms, and the relay that receives them (a Cloudflare Worker: `src/`, `schema/`, `wrangler.toml`). [PLAN.md](PLAN.md) holds the owner's decisions, the contract with the app, setup and free-plan limits; read it before changing anything.

## Rules

- **The contract is shared.** The app in Kmandevr/C.A.W is built to PLAN.md's "The contract with the app". Change it only with the owner, and in both places (here and C.A.W's `docs/decisions.md`).
- **Nothing about the user, ever.** The schema in `src/schema.js` is an allow-list; never widen it to anything that could identify a person (names, paths, accounts, MIDI, location, IDs that link reports). The relay never stores IP addresses or contact emails anywhere public.
- **Zero cost.** Cloudflare Workers Free plan only: never add a payment method, a paid plan or a paid product. Stay well inside the limits in PLAN.md (check Cloudflare's docs and date them before relying on a limit).
- **No secrets in this repo.** The only secret is `GITHUB_TOKEN`, a Worker secret the owner sets in the Cloudflare dashboard.
- **`data/` and `summaries/` are written by the relay only.** Don't hand-edit, regenerate or force-push them.
- **Facts are checked.** Never invent facts about Cloudflare, GitHub or the law: check a primary source and date it, or label it an assumption. PRIVACY.md and TERMS.md are drafts until a lawyer has checked them.
- **The owner works from an Android phone.** Give steps that work from a phone; don't assume a PC.

## Working here

- **Map:** `.claude/tools/tree.sh`. **Files and dependencies:** `.claude/tools/graph.sh query|explain|affected`. **Symbols:** Serena (the `code-nav` skill). Read only what those name.
- **Test:** `npm test` (Node 22.5+, no dependencies) after any change to `src/` or `schema/`.
- **Deploy:** through the claude.ai Cloudflare connector (upload `src/*.js` as modules with the bindings in `wrangler.toml`, keeping the `GITHUB_TOKEN` secret), or `npx wrangler deploy` with a Cloudflare API token. Ask the owner before deploying, and smoke-test `GET /` afterwards.
- **Schema changes:** the D1 tables are in `schema/d1.sql`; apply additive changes only, through the connector's D1 query endpoint.
- Record decisions and new facts in PLAN.md, rewriting superseded text where it stands.
