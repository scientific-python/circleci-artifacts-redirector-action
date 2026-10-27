// GitHub App front end: a Cloudflare Worker that receives `status` webhooks and
// posts the artifact link itself, so repos do not need a workflow at all (and
// therefore do not get a workflow run per status event, gh-27).
//
// The resolution logic is shared with the action; only the plumbing is here.
//
// Deploy:  wrangler deploy
// Secrets: wrangler secret put APP_ID / PRIVATE_KEY / WEBHOOK_SECRET
//
// PRIVATE_KEY must be the PKCS#8 form of the App's key, which GitHub does not
// hand you directly:
//   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
//       -in downloaded.private-key.pem -out pkcs8.pem

import { normalizeConfig, parseConfig } from '../src/config.js'
import { resolveStatus } from '../src/core.js'

export const CONFIG_DIR = '.github'
export const CANONICAL_CONFIG = 'circleci-artifacts.yml'
// People migrate by `git mv`-ing their old workflow, which is variously called
// circle_artifacts.yml (SciPy), circle-artifacts.yml, circleci_artifacts.yml…
// so accept any of those spellings rather than making them rename the file.
export const CONFIG_NAME = /^circle(ci)?[-_]artifacts\.ya?ml$/
// Cloudflare can reuse an isolate across requests, so a plain Map caches the
// token and config per isolate. Nothing here is correctness-critical: a cold
// isolate simply fetches again.
export const TOKEN_TTL_MS = 50 * 60 * 1000   // installation tokens last an hour
export const CONFIG_TTL_MS = 10 * 60 * 1000
export const DEDUPE_TTL_MS = 5 * 60 * 1000
// ...but in practice Cloudflare spreads deliveries over so many isolates that
// the Map rarely hits (13 isolates for 19 deliveries in one tail), and a miss
// costs a token mint plus a config read: 5-13 ms of the 10 ms CPU limit. So the
// config, which changes rarely, is also shared across isolates through KV when
// the CONFIG_CACHE binding exists. This is what makes an installation on a
// repo with no config (an org-wide install, say) cheap: its deliveries end at
// a KV read, with no token minted at all. The cost is that adding or editing
// a config can take up to KV_CONFIG_TTL_S (plus CONFIG_TTL_MS) to take effect.
// The key carries a format version so that a rollback never misreads a value.
export const KV_CONFIG_TTL_S = 60 * 60
export const KV_CONFIG_PREFIX = 'config:v1:'
const cache = new Map()

export function clearCache() {
  cache.clear()
}

// Memoize a promise, evicting it if it rejects so that a blip is not cached
// for the whole TTL. Storing the promise (not the value) also means concurrent
// events for the same repo share one request.
export function cached(key, ttl, produce, now = Date.now) {
  const hit = cache.get(key)
  if (hit && hit.expires > now()) {
    return hit.value
  }
  const value = produce()
  cache.set(key, {value, expires: now() + ttl})
  value.catch(() => {
    if (cache.get(key)?.value === value) {
      cache.delete(key)
    }
  })
  return value
}
// True if this exact key was seen recently, recording it if not. CircleCI
// sometimes delivers the same status twice, and each delivery would otherwise
// post an identical status: invisible in the UI, since GitHub only shows the
// latest per context, but it doubles both the posts and the status events they
// generate. Best-effort by design -- two simultaneous duplicates can still both
// miss, and a cold isolate forgets everything.
export function seenRecently(key, ttl, now = Date.now) {
  const hit = cache.get(key)
  if (hit && hit.expires > now()) {
    return true
  }
  cache.set(key, {value: true, expires: now() + ttl})
  return false
}

const API = 'https://api.github.com'
const UA = {'user-agent': 'circleci-artifacts-redirector-app', 'accept': 'application/vnd.github+json'}
const ENC = new TextEncoder()

// The webhook secret and the App key are fixed for the life of a deployment,
// so import each into Web Crypto once per isolate instead of on every use --
// the HMAC import ran on every delivery. Keyed by the raw material rather than
// invalidated, so a rotated secret (or a test) never sees a stale key.
let hmacSecret, hmacKey
let rsaPem, rsaKey

// Constant-time-ish comparison of the webhook signature.
export async function verifySignature(secret, body, signature) {
  // An unset secret must fail closed rather than throw: Web Crypto rejects a
  // zero-length HMAC key, which would otherwise surface as a 500
  if (!secret || !signature || !signature.startsWith('sha256=')) {
    return false
  }
  const bytes = signature.slice('sha256='.length)
  if (bytes.length !== 64 || !/^[0-9a-f]+$/.test(bytes)) {
    return false
  }
  if (secret !== hmacSecret) {
    hmacSecret = secret
    hmacKey = crypto.subtle.importKey(
      'raw', ENC.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify'])
  }
  const provided = Uint8Array.from(bytes.match(/../g).map((h) => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', await hmacKey, provided, ENC.encode(body))
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Mint an installation access token: sign a JWT with the App key, then trade it
// in for a token scoped to the repo the event came from.
export async function mintToken({appId, privateKey, installationId, fetchFn = globalThis.fetch, now = Date.now}) {
  if (privateKey !== rsaPem) {
    rsaPem = privateKey
    rsaKey = (async () => {
      const der = Uint8Array.from(
        atob(privateKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')),
        (c) => c.charCodeAt(0))
      return crypto.subtle.importKey(
        'pkcs8', der, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign'])
    })()
  }
  // An unimportable key rejects identically every time, so caching the
  // rejection is as correct as recomputing it
  const key = await rsaKey
  const issued = Math.floor(now() / 1000) - 60
  const claims = {iat: issued, exp: issued + 600, iss: appId}
  const unsigned = `${base64url(ENC.encode(JSON.stringify({alg: 'RS256', typ: 'JWT'})))}.` +
    `${base64url(ENC.encode(JSON.stringify(claims)))}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, ENC.encode(unsigned))
  const jwt = `${unsigned}.${base64url(signature)}`

  const response = await fetchFn(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {...UA, authorization: `Bearer ${jwt}`},
  })
  if (!response.ok) {
    throw new Error(`Could not mint an installation token: ${response.status}`)
  }
  return (await response.json()).token
}

// Read the config from the *default branch*, never the PR head: otherwise a
// forked PR could point `domain` at a host it controls and have us post a
// trusted-looking link to it.
export async function readConfig(fetchFn, repo, token) {
  const headers = {...UA, authorization: `Bearer ${token}`}
  const ref = `?ref=${repo.default_branch}`
  const listing = await fetchFn(`${API}/repos/${repo.full_name}/contents/${CONFIG_DIR}${ref}`, {headers})
  if (listing.status === 404) {
    return null   // no .github directory at all
  }
  if (!listing.ok) {
    throw new Error(`Could not list ${CONFIG_DIR}: ${listing.status}`)
  }
  const entries = await listing.json()
  if (!Array.isArray(entries)) {
    return null
  }
  const files = entries.filter((entry) => entry.type === 'file' && CONFIG_NAME.test(entry.name))
  // Prefer the documented spelling when a repo somehow has several
  const file = files.find((entry) => entry.name === CANONICAL_CONFIG) ?? files[0]
  if (file === undefined) {
    return null
  }
  const response = await fetchFn(`${API}/repos/${repo.full_name}/contents/${file.path}${ref}`, {headers})
  if (!response.ok) {
    throw new Error(`Could not read ${file.path}: ${response.status}`)
  }
  const {content} = await response.json()
  return parseConfig(atob(content.replace(/\s/g, '')))
}

// Like cached(), but records in trace[field] whether the value had to be
// produced, so the log can show how often the per-isolate caches actually hit.
function traced(trace, field, key, ttl, produce, now) {
  trace[field] = 'hit'
  return cached(key, ttl, () => {
    trace[field] = 'miss'
    return produce()
  }, now)
}

// Read the config through KV when it is bound, falling back to `read` (the
// GitHub API) on a miss and storing what it returns -- including null, which
// is the whole point for a repo with no config. KV is best-effort like every
// other cache here: a failed get or put (the free plan allows 1,000 writes a
// day) is recorded in the trace and otherwise ignored, never failing the
// delivery.
export async function sharedConfig(kv, key, read, trace) {
  if (!kv) {
    return read()
  }
  const stored = await kv.get(KV_CONFIG_PREFIX + key, 'json').catch(() => {
    trace.kv = 'get-error'
    return null
  })
  if (stored !== null) {
    trace.kv = 'hit'
    return stored.config
  }
  trace.kv ??= 'miss'
  const config = await read()
  await kv.put(KV_CONFIG_PREFIX + key, JSON.stringify({config}), {expirationTtl: KV_CONFIG_TTL_S})
    .catch(() => {
      trace.kv = 'put-error'
    })
  return config
}

// `trace` collects facts about this delivery for the fetch handler to log;
// handle() only ever adds to it.
export async function handle(request, env, {fetchFn = globalThis.fetch, log = () => {}, now = Date.now, trace = {}} = {}) {
  if (request.method !== 'POST') {
    return new Response('POST only', {status: 405})
  }
  const body = await request.text()
  trace.bytes = body.length
  if (!await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature', {status: 401})
  }
  if (request.headers.get('x-github-event') !== 'status') {
    return new Response('ignored: not a status event', {status: 200})
  }

  const payload = JSON.parse(body)
  trace.context = payload.context
  trace.state = payload.state
  // Cheap filter first: most status events on a busy repo are not ours, and
  // this path must not cost an API call
  if (!(payload.context ?? '').startsWith('ci/circleci: ')) {
    return new Response('ignored: not a CircleCI status', {status: 200})
  }
  // The app never posts a pending status, so answer before the token mint and
  // config read below: CircleCI sends a pending as each job starts, making
  // this about half of all watched-job deliveries, and on a cold isolate the
  // work skipped is an RSA sign plus two GitHub API calls.
  if (payload.state === 'pending') {
    return new Response('ignored: pending, the app posts no pending statuses', {status: 200})
  }

  const repo = payload.repository
  trace.repo = repo.full_name
  trace.installation = payload.installation.id
  // Minted only when something needs it -- reading the config on a cache miss,
  // or posting -- so a delivery the cached config rules out (no config file,
  // a job that is not watched) never pays for the RSA sign
  let minted
  const token = () => minted ??= traced(trace, 'token', `token:${payload.installation.id}`, TOKEN_TTL_MS, () => mintToken({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    installationId: payload.installation.id,
    fetchFn,
  }), now)
  const configKey = `${repo.full_name}@${repo.default_branch}`
  const raw = await traced(
    trace, 'config', `config:${configKey}`, CONFIG_TTL_MS,
    () => sharedConfig(env.CONFIG_CACHE, configKey, async () => readConfig(fetchFn, repo, await token()), trace), now)
  if (raw === null) {
    return new Response(`ignored: no ${CONFIG_DIR}/${CANONICAL_CONFIG}`, {status: 200})
  }
  // The app never posts a pending status: it would double the webhook traffic
  // it generates for no benefit the final status does not already provide
  const config = {...normalizeConfig(raw), postPending: false}
  if (config.path === '') {
    return new Response('ignored: no artifact-path configured', {status: 200})
  }

  const status = await resolveStatus({payload, config, fetchFn, log})
  if (status === null) {
    return new Response('ignored: not a watched job, or no artifacts with no-artifact-state: skip', {status: 200})
  }

  // The URL is part of the key, so a re-run that produces different artifacts
  // still posts, while a duplicate delivery of the same event does not
  const key = `posted:${repo.full_name}:${payload.sha}:${status.context}:${status.state}:${status.url}`
  if (seenRecently(key, DEDUPE_TTL_MS, now)) {
    return new Response(`ignored: already posted ${status.state}`, {status: 200})
  }

  const response = await fetchFn(`${API}/repos/${repo.full_name}/statuses/${payload.sha}`, {
    method: 'POST',
    headers: {...UA, authorization: `Bearer ${await token()}`},
    body: JSON.stringify({
      state: status.state,
      target_url: status.url,
      description: status.description,
      context: status.context,
    }),
  })
  if (!response.ok) {
    throw new Error(`Could not post the status: ${response.status}`)
  }
  return new Response(`posted ${status.state}: ${status.url}`, {status: 200})
}

// resolveStatus narrates its steps through `log`; keep the plain strings and
// drop thunks unevaluated, since those are the expensive ones (see CLAUDE.md).
// The strings are built whether or not anyone keeps them, so this is free.
export function keepSteps(steps) {
  return (message) => {
    if (typeof message === 'string') {
      steps.push(message)
    }
  }
}

// Which isolate served a delivery and how many it had served by then, so the
// log can tell a cold isolate (served: 1) from a warm one. The id is made on
// first use because Workers forbid randomness at global scope.
let isolate
let served = 0

export default {
  async fetch(request, env) {
    isolate ??= crypto.randomUUID().slice(0, 8)
    const trace = {delivery: request.headers.get('x-github-delivery'), isolate, served: ++served, steps: []}
    let response
    try {
      response = await handle(request, env, {log: keepSteps(trace.steps), trace})
    } catch (error) {
      // A 500 tells GitHub the delivery failed, so it shows up in the App's
      // "Recent Deliveries" tab rather than vanishing. GitHub never retries a
      // failed delivery on its own, so a transient CircleCI or GitHub blip
      // means this one status is simply never posted -- accepted: a build
      // emits several status events, and the fix (a cron redelivering via the
      // App API) would put App credentials in CI. See CLAUDE.md.
      response = new Response(String(error), {status: 500})
    }
    // One structured record per delivery saying which path it took and what it
    // cost in API calls, so Workers Logs (which records each invocation's CPU
    // time alongside it, and indexes these fields) can attribute the CPU tail;
    // analytics alone cannot split it. See CLAUDE.md.
    console.log({...trace, status: response.status, result: await response.clone().text()})
    return response
  },
}
