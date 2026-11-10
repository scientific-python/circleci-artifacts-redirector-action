#!/usr/bin/env node
// Redeliver the GitHub App's failed `status` webhook deliveries.
//
//   tools/redeliver.mjs --app-id <ID> --key <private-key.pem> [--since YYYY-MM-DD] [--apply]
//
// e.g., with the files in ~/.secrets:
//   tools/redeliver.mjs --app-id "$(cat ~/.secrets/circleci-artifacts-redirector-app-id)" \
//       --key ~/.secrets/circleci-artifacts-redirector.2026-08-26.private-key.pem --since 2026-11-09
//
// GitHub never retries a failed delivery on its own (see CLAUDE.md), so when
// the Worker 500s -- a Worker bug, or a CircleCI/GitHub blip -- this is how the
// lost statuses get posted once the cause is fixed and deployed. GitHub keeps
// deliveries for about 3 days, so --since defaults to 3 days ago.
//
// Without --apply it only lists what it would redeliver, oldest first, with
// the response each one got. It authenticates as the App (a JWT signed with
// the App's private key, PKCS#1 or PKCS#8, which never leaves this machine)
// because the deliveries API accepts nothing else. Deliberately a local tool
// and not a workflow: App credentials never go to CI.
//
// Picked: `status` deliveries since --since whose response was a 5xx, minus
//   - any delivery whose GUID already has a successful attempt, so a rerun,
//     or a manual redelivery from the UI, is never repeated, and
//   - CircleCI's duplicates: one delivery per (repo, sha, context, state).
// Redeliveries go one per second, to stay clear of secondary rate limits.
import {readFileSync} from 'node:fs'
import {createSign} from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const appId = opt('--app-id')
const keyPath = opt('--key')
const since = Date.parse(opt('--since') ?? new Date(Date.now() - 3 * 86400_000).toISOString())
const apply = args.includes('--apply')
if (!appId || !keyPath || Number.isNaN(since)) {
  console.error('usage: tools/redeliver.mjs --app-id <ID> --key <private-key.pem> [--since YYYY-MM-DD] [--apply]')
  process.exit(2)
}
const key = readFileSync(keyPath, 'utf8')   // PKCS#1 or PKCS#8 both work here

function jwt() {
  const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url')
  const now = Math.floor(Date.now() / 1000) - 60
  const unsigned = `${b64({alg: 'RS256', typ: 'JWT'})}.${b64({iat: now, exp: now + 540, iss: appId})}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')}`
}

async function gh(path, method = 'GET') {
  const response = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
    method,
    headers: {authorization: `Bearer ${jwt()}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'circleci-artifacts-redirector-redeliver'},
  })
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
  // Delivery IDs run past 2^53, so JSON.parse would round them (and the
  // rounded ID 404s): quote every long integer before parsing, keeping it exact
  const text = await response.text()
  const body = text === '' ? null : JSON.parse(text.replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'))
  return {body, link: response.headers.get('link')}
}

// Newest first; stop paging once past --since
const deliveries = []
let next = '/app/hook/deliveries?per_page=100'
while (next) {
  const {body, link} = await gh(next)
  deliveries.push(...body)
  const older = body.length && Date.parse(body.at(-1).delivered_at) < since
  next = older ? null : link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
}
const okGuids = new Set(deliveries.filter((d) => d.status_code < 300).map((d) => d.guid))
const failed = deliveries.filter((d) => d.event === 'status' && d.status_code >= 500
  && Date.parse(d.delivered_at) >= since && !okGuids.has(d.guid))
console.error(`${deliveries.length} deliveries listed, ${failed.length} failed status deliveries since ${new Date(since).toISOString()} with no successful attempt`)

const seen = new Set()
const picked = []
for (const d of failed.reverse()) {   // oldest first
  const {body: detail} = await gh(`/app/hook/deliveries/${d.id}`)
  const p = detail.request.payload
  const what = `${p.repository?.full_name} ${p.sha?.slice(0, 7)} ${p.context} ${p.state}`
  if (seen.has(what)) {
    continue   // CircleCI's duplicate of one already picked
  }
  seen.add(what)
  picked.push({d, what, why: String(detail.response?.payload ?? '').slice(0, 70)})
}

for (const {d, what, why} of picked) {
  console.log(`${d.delivered_at}  ${what}  [${why}]`)
}
console.error(`${picked.length} unique to redeliver${apply ? '' : ' (dry run: add --apply to send them)'}`)
if (apply) {
  let done = 0
  for (const {d, what} of picked) {
    try {
      await gh(`/app/hook/deliveries/${d.id}/attempts`, 'POST')
      done++
    } catch (error) {
      console.error(`FAILED ${what}: ${error.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))   // stay clear of secondary rate limits
  }
  console.error(`requested ${done} of ${picked.length} redeliveries; check the App's Recent Deliveries tab`)
}
