# CLAUDE.md

Notes for agents working on this repo. User-facing docs live in `README.md`;
this file is the working knowledge that is easy to get wrong.

## What this is

Two front ends over one core, for putting a link to a CircleCI artifact into a
GitHub commit status:

| File | Role |
|---|---|
| `src/core.js` | all the logic; runtime-neutral (global `fetch` only, nothing from `node:`) |
| `src/config.js` | option names, defaults and the config-file parser, shared by both |
| `index.js` | GitHub Action entry point (`@actions/core`, `@actions/github`) |
| `worker/index.js` | GitHub App entry point: a Cloudflare Worker handling `status` webhooks |
| `dist/index.js` | the bundle the action actually runs; **committed**, built by `ncc` |
| `tools/cf-usage.py` | Cloudflare usage report for the deployed Worker (stdlib only) |

Keep logic in `src/`. Anything added to only one front end will drift; that is
the whole reason the split exists.

## Commands

```bash
npm test          # eslint + node --test
npm run coverage  # the same, with a hard 100% line/branch/function floor
npx ncc build index.js -o dist   # after ANY change to index.js or src/
pre-commit run --all-files       # yamllint + eslint, as CI runs them
npx wrangler deploy              # manual deploy; normally CI does this, see below
tools/cf-usage.py [days]         # deployed Worker usage vs the free-tier limits
```

CI enforces 100% coverage. New code needs tests, or `/* node:coverage
disable */` with a reason (see the entry-point guard in `index.js`).

## Conventions

- **No semicolons, single quotes**, `eqeqeq` with `{null: 'ignore'}` — enforced
  by `eslint.config.mjs`, all autofixable with `npx eslint . --fix`.
- **Rebuild `dist/`** in the same commit as any `index.js`/`src/` change, or
  the action ships stale code. autofix.ci also does this on PRs, and the
  `check-dist` job in `tests.yaml` verifies it — on a `master` push a failure
  opens an issue, because nobody watches post-merge CI.
- **Bot PRs that touch `dist/` are never auto-merged.** `dist/` is what every
  consumer of the action executes, so a dependency bump that autofix.ci
  re-bundles must get human review — otherwise a compromised npm release would
  flow to consumers' CI with no human in the loop. `automerge.yml` enforces it
  (including *disabling* auto-merge when autofix pushes a rebuilt `dist/` to a
  PR it already approved), and dependabot has a 14-day `cooldown` on npm so a
  poisoned release is likely yanked before we ever see it.
- **`.pre-commit-config.yaml` pins ESLint separately from `package.json`** and
  dependabot only updates the latter. Bump both together.
- Style-only commits go in `.git-blame-ignore-revs`.
- Node version comes from `.nvmrc` (CircleCI orb and `setup-node` both read it).

## Testing style

`node:test`, no framework. The action is tested by setting real `INPUT_*` env
vars and injecting `fetchFn`/`getOctokit`; the Worker by building a real
`Request` and injecting `fetchFn`. Both use the real `@actions/core` and real
Web Crypto — the JWT test signs with a generated key and verifies with
`node:crypto`, so it would be accepted by GitHub.

**Mutation-test any fix**: revert it alone and confirm the new test fails. This
caught a test that passed with *and* without the fix (an HTTP-error test that
only asserted "the job failed", when the old code also failed, just with a
useless message).

## Hard-won gotchas

Things that cost real debugging time. Do not undo these.

- **Never send `Circle-Token` unless a token was supplied.** CircleCI answers
  `401` to a bogus token even on public projects, while no header at all is
  `200`. Sending the literal string `"null"` broke every tokenless public repo
  (gh-119).
- **The status reports the link, not the build** (gh-57): green when artifacts
  exist, red when they do not, regardless of whether CircleCI passed.
- **Do not add exact `artifact-path` matching.** It was proposed and declined:
  CircleCI lists only files, so anyone whose path is a directory (`0/dev/`,
  relying on an index redirect) would go permanently red. A broken link is the
  lesser evil. Revisiting it would also need `next_page_token` paging.
- **The app must read config from the default branch.** Reading it from the
  event's ref would let a forked PR point `domain:` at a host it controls and
  have us post a trusted-looking link to it. Verified live with a fork PR whose
  branch config said `SHOULD NOT APPEAR`.
- **`on: status` cannot be filtered** — no `types`, no branches, and the
  workflow must exist on the default branch. Job-level `if` skips the work but
  the run entry is still created, which is gh-27. Every status the action posts
  is itself a `status` event, so it triggers its own workflow again; that is why
  `post-pending` exists.
- **A fork that is itself a followed CircleCI project suppresses upstream
  builds.** CircleCI builds it in the fork's project and never creates a
  `pull/N` pipeline in the parent, so the upstream PR shows no status while
  every setting looks correct. Check
  `/api/v1.1/project/github/<org>/<repo>/settings` for `build-fork-prs`.
- **Never suggest installing the CircleCI GitHub App as a fix for forked PRs**
  — App pipelines are *never* built on forks, so it makes this strictly worse.
  The OAuth integration is the one that supports them.

## The GitHub App

Deploy: normally `.github/workflows/deploy.yml`, on a published release or a
manual `workflow_dispatch`; `npx wrangler deploy` still works for emergencies.
Worker secrets: `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` via
`wrangler secret put` — these live **on the Worker and survive a deploy**, so
CI never needs them and must never be given them.

- `PRIVATE_KEY` must be **PKCS#8** (`openssl pkcs8 -topk8 -nocrypt …`); Web
  Crypto cannot import the PKCS#1 file GitHub gives you.
- Upload `WEBHOOK_SECRET` with `printf '%s'`, never `< file` — a trailing
  newline makes every delivery `401`. The same trap caught
  `CLOUDFLARE_API_TOKEN` as a repo secret, where a pasted newline became an
  invalid `Authorization` header. **Every credential in this project has to be
  stored with no trailing newline**, and nothing in any UI shows you one; the
  deploy workflow now rejects whitespace up front for the two it can see.
- Token (50 min), config (10 min) and posted-status dedupe (5 min) are cached in
  an isolate-level `Map`. All best-effort: a cold isolate just refetches, and a
  duplicate can slip through. Nothing is correctness-critical.
- Repos with no config file are inert, so a stale installation posts nothing.
- **A failed delivery is lost — accepted.** GitHub never retries a webhook
  delivery on its own, so when the Worker 500s on a transient CircleCI/GitHub
  blip, that one status is never posted. A build emits several status events,
  so the exposure is small; the "fix" (a cron job calling the App's redeliver
  API) would hand App credentials to CI, which we deliberately never do. Manual
  redelivery from Recent Deliveries covers the rare case that matters.
- The config file is found by **listing `.github/` and matching
  `CONFIG_NAME`** (`circle(ci)?[-_]artifacts.ya?ml`) rather than fetching one
  fixed path: people migrate by `git mv`-ing their workflow, which is called
  `circle_artifacts.yml` in SciPy and MNE-Python. Costs one extra API call when
  a config exists, cached for 10 minutes.
- Responses are the diagnostic surface: the App's Advanced → Recent Deliveries
  tab shows exactly which stage a delivery reached.

### Deploying from CI

`.github/workflows/deploy.yml` runs `wrangler deploy` on a published release or
a manual `workflow_dispatch`. Two repo secrets, both scoped to the `production`
environment:

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dashboard → My Profile → API Tokens, **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | dashboard → Workers & Pages → Account ID |

For local read-only work, mint a *second* token rather than reusing the deploy
one — it can write to production. `tools/cf-usage.py` needs exactly **Account
Analytics: Read**, provided `CLOUDFLARE_ACCOUNT_ID` is exported too; without it
the script falls back to listing accounts, which additionally needs Account
Settings: Read. Add **Workers Tail: Read** to that token if you also want
`wrangler tail` to stream live deliveries.

Not on every push to `master`: the Worker is production for every repo with the
App installed, so deploying is a decision rather than a consequence of merging.
`workflow_dispatch` exists because Worker-only fixes should not have to wait for
an action release — action releases run at a few per year, and a Worker fix
(gh-126 was one) can be urgent.

The token from `wrangler login` is a *different* credential, expires about an
hour after issue, and this repo's tooling cannot refresh it — hence the API
token above, which does not expire.

### Rolling back a bad deploy

**Roll back first, revert git after.** They are not alternatives:

1. Run the Deploy workflow with a **`rollback_to`** version ID. Cloudflare
   re-serves a version it already has, so this needs no build, no tests and no
   working tree — it is the one thing that still works when `master` is broken.
   Version IDs are printed at the end of every run of the workflow.
2. *Then* `git revert` and merge. **Cloudflare is now ahead of `master`, and the
   next deploy silently re-ships whatever you rolled back.** This step is what
   reconciles them, and skipping it is how the same outage happens twice.

`git revert` + merge + `workflow_dispatch` on its own is a full PR and CI cycle
to fix an outage, and it cannot help at all if the problem is that `master` does
not build. Use it as step 2, never as step 1.

Rollback is a no-op risk here: the restriction in Cloudflare's docs is about
Durable Objects, R2, KV and queues changing between versions, and this Worker
has no bindings at all (`wrangler deploy --dry-run` reports "No bindings
found"). Secrets are not touched. Only recent versions are retained — the docs
say the last 100, `wrangler versions list` shows the last 10.

### CPU is the limit that binds, not requests

The free plan allows 100,000 requests/day but only **10 ms of CPU per
invocation** (I/O does not count, so awaiting GitHub and CircleCI is free).
Requests are a non-issue — measured traffic is well under 1% of the daily cap,
with ~200x headroom — while the observed CPU p99 already sits near 10 ms. When
a Worker consistently exceeds it, Cloudflare terminates the invocation with
error 1102; occasional overruns are tolerated.

What actually costs CPU here, measured on a scikit-learn-sized listing:

| Operation | Cost |
|---|---|
| `JSON.stringify` of the artifacts listing (~1 MB) | ~2.8 ms |
| `JSON.parse` of that same listing | ~2.2 ms |
| RSA import + JWT sign (only on a token cache miss) | ~1.0 ms |
| **streaming scan for the first artifact URL** | **~0.08 ms** |
| HMAC import + webhook signature verify | ~0.08 ms |

A large docs build lists thousands of files (scikit-learn: 3,904 artifacts,
982 KB; MNE-Python: 3,290, 755 KB), so **anything that touches the whole
artifacts payload is the most expensive thing the Worker does** — more than the
crypto, by a lot. Both halves of that have now been removed:

- **Never serialize it.** `src/core.js` passes a **thunk** to `log` for messages
  that are expensive to build, and the Worker's `log` is a no-op that never
  calls it. Do not "simplify" a thunk back into a template string — a no-op
  logger still evaluates its argument, which is exactly the bug it fixes.
  `index.js` resolves the thunk only when `core.isDebug()`. Nothing passes a
  thunk today (the message that did is gone, below), but the contract holds and
  the next expensive message must use it.
- **Never parse it.** Only two facts about the listing matter: whether the job
  uploaded anything, and the URL of one artifact — they all share the job
  segment the redirect needs. `firstArtifactUrl` scans the response bytes as
  they arrive, stops at the first `"url"`, and cancels the rest of the download,
  turning ~2.2 ms into ~0.08 ms and skipping most of the transfer as well. The
  regex cannot be fooled by a path containing the text `"url":`, because an
  unescaped `"` only appears as JSON syntax, never inside a string value. If the
  scan finds nothing before the stream ends it parses the (then tiny, or
  unexpected) body properly, so a malformed response still throws instead of
  quietly reading as "no artifacts".

The cost of that second one is debuggability: there is no longer a full
`Artifacts JSON: …` dump in the action's debug log, because the payload is never
assembled. `First artifact: <url>` replaces it.

Four tests pin this down (`index.test.js`, `worker/index.test.js`). The fake
artifacts payload carries a `toJSON` hook that counts serializations and the
tests assert it is never called; a second fixture serves the listing as a real
chunked `ReadableStream` and asserts the scan pulls at most 2 of ~15 chunks.
Both are deterministic tripwires for the specific wasteful operation, where
asserting on elapsed milliseconds would be flaky. Add the same guard for any new
code that could walk the payload.

Check real usage with `tools/cf-usage.py` (`$CLOUDFLARE_API_TOKEN` if exported,
else the token `wrangler login` stored). It reports CPU quantiles and invocation
outcomes, and flags a p99 over the limit. `--check` exits non-zero on anything
worth a look; `.github/workflows/usage.yml` runs that weekly and opens (or
comments on) an issue on failure, so the limit check does not depend on anyone
remembering to run it. That workflow needs two **repo-level** secrets:
`CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read **only**, never the
deploy token) and `CLOUDFLARE_ACCOUNT_ID` (a second copy — the deploy one is
scoped to the `production` environment, out of cron's reach by design).

## Where things stand (2026-07-28)

The App prototype is merged/being merged from `app-prototype`. It is **running
in production for `LABSN/expyfun`**, which removed its workflow — but on a
*personal* Cloudflare account and a personally-owned App registration, not
scientific-python infrastructure.

Next steps, roughly in order:

1. More repos: `scikit-image/scikit-image` and `braindecode/braindecode`
   already have the App installed (since 2019) and only need a config file.
   Then MNE-Python and SciPy.
2. Hand over to scientific-python: App ownership transfers preserve
   installations, and the Worker is stateless, so it is `wrangler deploy` +
   three Worker secrets + two repo secrets (see "Deploying from CI") + one
   webhook URL change. Stefan van der Walt (stefanv) runs
   the org's existing Cloudflare Worker (`scientific-python/circleci-proxy`);
   he and Jarrod Millman are the org owners.
3. Measured load for scikit-learn + MNE-Python + SciPy combined: ~8,200
   deliveries/week, about 1.2% of the Workers free tier.

Not supported by the App, by design: private CircleCI projects (would need
server-side token storage) and the `url` output (no workflow step to consume
it). The action remains the answer for both, and is not going away.
