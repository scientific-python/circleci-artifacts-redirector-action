import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import worker, { handle, verifySignature, mintToken, readConfig, clearCache, CONFIG_PATH, TOKEN_TTL_MS, CONFIG_TTL_MS, DEDUPE_TTL_MS } from './index.js'
import { parseConfig, normalizeConfig } from '../src/config.js'

beforeEach(clearCache)

const SECRET = 'webhook-secret'
// A throwaway key, generated once here, so the JWT path runs for real
const {privateKey} = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
  publicKeyEncoding: {type: 'spki', format: 'pem'},
})
const ENV = {APP_ID: '123', PRIVATE_KEY: privateKey, WEBHOOK_SECRET: SECRET}

const CONFIG = 'artifact-path: 0/doc/index.html\njob-title: Docs preview\n'
const ARTIFACT = {url: 'https://output.circle-artifacts.com/output/job/abc/artifacts/0/doc/other.html'}

const PAYLOAD = {
  context: 'ci/circleci: build',
  state: 'success',
  sha: 'deadbeef',
  target_url: 'https://circleci.com/gh/scientific-python/demo/94',
  repository: {full_name: 'scientific-python/demo', default_branch: 'main'},
  installation: {id: 42},
}

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function webhook(payload, {event = 'status', secret = SECRET, method = 'POST'} = {}) {
  const body = JSON.stringify(payload)
  return new Request('https://worker.example/', {
    method,
    body: method === 'POST' ? body : undefined,
    headers: {'x-github-event': event, 'x-hub-signature-256': sign(body, secret)},
  })
}

// Fake GitHub + CircleCI. Returns the requests it saw so tests can assert on
// what would have been posted.
function backend({config = CONFIG, artifacts = {items: [ARTIFACT]}, statusCode = 201} = {}) {
  const seen = []
  const fetchFn = async (url, options = {}) => {
    seen.push({url, method: options.method ?? 'GET', body: options.body})
    if (url.endsWith('/access_tokens')) {
      return new Response(JSON.stringify({token: 'ghs_installation'}), {status: 201})
    }
    if (url.includes(`/contents/${CONFIG_PATH}`)) {
      return config === null
        ? new Response('{}', {status: 404})
        : new Response(JSON.stringify({content: btoa(config)}), {status: 200})
    }
    if (url.includes('/artifacts')) {
      return new Response(JSON.stringify(artifacts), {status: 200})
    }
    if (url.includes('/statuses/')) {
      return new Response('{}', {status: statusCode})
    }
    throw new Error(`unexpected request: ${url}`)
  }
  return {fetchFn, seen}
}

test('posts a status for a CircleCI event', async () => {
  const {fetchFn, seen} = backend()
  const response = await handle(webhook(PAYLOAD), ENV, {fetchFn})
  assert.equal(response.status, 200)

  const posted = seen.find((r) => r.url.includes('/statuses/'))
  assert.ok(posted, 'a status was posted')
  assert.equal(posted.url, 'https://api.github.com/repos/scientific-python/demo/statuses/deadbeef')
  assert.deepEqual(JSON.parse(posted.body), {
    state: 'success',
    target_url: 'https://output.circle-artifacts.com/output/job/abc/artifacts/0/doc/index.html',
    description: 'Link to 0/doc/index.html',
    context: 'Docs preview',
  })
})

test('reads the config from the default branch, not the event', async () => {
  const {fetchFn, seen} = backend()
  await handle(webhook(PAYLOAD), ENV, {fetchFn})
  const read = seen.find((r) => r.url.includes(`/contents/${CONFIG_PATH}`))
  assert.match(read.url, /\?ref=main$/, 'pinned to the default branch')
})

test('rejects a bad signature before doing anything', async () => {
  const {fetchFn, seen} = backend()
  const response = await handle(webhook(PAYLOAD, {secret: 'wrong'}), ENV, {fetchFn})
  assert.equal(response.status, 401)
  assert.deepEqual(seen, [], 'no API calls on an unverified body')
})

test('ignores non-status events and non-CircleCI contexts without any API call', async () => {
  for (const [request, why] of [
    [webhook(PAYLOAD, {event: 'push'}), 'wrong event'],
    [webhook({...PAYLOAD, context: 'codecov/patch'}), 'wrong context'],
    [webhook({...PAYLOAD, context: undefined}), 'no context'],
  ]) {
    clearCache()
    const {fetchFn, seen} = backend()
    const response = await handle(request, ENV, {fetchFn})
    assert.equal(response.status, 200, why)
    assert.deepEqual(seen, [], `no API calls: ${why}`)
  }
})

test('ignores repos with no config file, and configs with no artifact-path', async () => {
  for (const config of [null, 'job-title: incomplete\n']) {
    clearCache()
    const {fetchFn, seen} = backend({config})
    const response = await handle(webhook(PAYLOAD), ENV, {fetchFn})
    assert.equal(response.status, 200)
    assert.ok(!seen.some((r) => r.url.includes('/statuses/')), 'nothing posted')
  }
})

test('ignores a job the config does not watch', async () => {
  const {fetchFn, seen} = backend({config: 'artifact-path: p\ncircleci-jobs: other\n'})
  const response = await handle(webhook(PAYLOAD), ENV, {fetchFn})
  assert.equal(response.status, 200)
  assert.ok(!seen.some((r) => r.url.includes('/artifacts')), 'no CircleCI call either')
})

test('rejects non-POST', async () => {
  const {fetchFn} = backend()
  const response = await handle(webhook(PAYLOAD, {method: 'GET'}), ENV, {fetchFn})
  assert.equal(response.status, 405)
})

test('surfaces failures to post', async () => {
  const {fetchFn} = backend({statusCode: 403})
  await assert.rejects(() => handle(webhook(PAYLOAD), ENV, {fetchFn}), /Could not post the status: 403/)
})

test('surfaces failures to read config or mint a token', async () => {
  const broken = async (url) => url.endsWith('/access_tokens')
    ? new Response('{}', {status: 401})
    : new Response('{}', {status: 500})
  await assert.rejects(
    () => handle(webhook(PAYLOAD), ENV, {fetchFn: broken}), /Could not mint an installation token: 401/)

  const badConfig = async (url) => url.endsWith('/access_tokens')
    ? new Response(JSON.stringify({token: 't'}), {status: 201})
    : new Response('{}', {status: 500})
  await assert.rejects(
    () => handle(webhook(PAYLOAD), ENV, {fetchFn: badConfig}), new RegExp(`Could not read ${CONFIG_PATH}: 500`))
})

test('verifySignature rejects malformed headers', async () => {
  assert.equal(await verifySignature('', 'body', sign('body')), false, 'an empty secret never verifies')
  assert.equal(await verifySignature(undefined, 'body', sign('body')), false, 'nor an unset one')
  for (const header of [null, 'sha1=abc', 'sha256=nothex', 'sha256=' + 'a'.repeat(63)]) {
    assert.equal(await verifySignature(SECRET, 'body', header), false, `rejected: ${header}`)
  }
  assert.equal(await verifySignature(SECRET, 'body', sign('body')), true)
})

test('mintToken signs a real RS256 JWT', async () => {
  let authorization
  const fetchFn = async (url, options) => {
    authorization = options.headers.authorization
    return new Response(JSON.stringify({token: 'ghs_x'}), {status: 201})
  }
  const token = await mintToken({
    appId: '123', privateKey, installationId: 7, fetchFn, now: () => 1_000_000_000_000})
  assert.equal(token, 'ghs_x')

  const [header, claims, signature] = authorization.replace('Bearer ', '').split('.')
  assert.deepEqual(JSON.parse(atob(header)), {alg: 'RS256', typ: 'JWT'})
  const parsed = JSON.parse(atob(claims))
  assert.equal(parsed.iss, '123')
  assert.equal(parsed.exp - parsed.iat, 600)
  // Verify the signature against the public half, i.e. GitHub would accept it
  const verified = crypto.createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(privateKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
  assert.ok(verified, 'the JWT signature checks out')
})

test('readConfig returns null when the file is missing', async () => {
  const fetchFn = async () => new Response('{}', {status: 404})
  assert.equal(await readConfig(fetchFn, {full_name: 'a/b', default_branch: 'main'}, 't'), null)
})

test('parseConfig handles the shapes a migrated workflow produces', () => {
  assert.deepEqual(parseConfig([
    '# a comment',
    '',
    'artifact-path: 0/doc/index.html',
    'job-title: "Check the rendered docs here!"',
    "circleci-jobs: 'build_docs, doc'",
    'domain: circle.scientific-python.dev  # via the proxy',
    'not a mapping line',
  ].join('\n')), {
    'artifact-path': '0/doc/index.html',
    'job-title': 'Check the rendered docs here!',
    'circleci-jobs': 'build_docs, doc',
    'domain': 'circle.scientific-python.dev',
  })
})

test('normalizeConfig applies the same defaults as the action', () => {
  const config = normalizeConfig({'artifact-path': ' p '})
  assert.deepEqual(config.jobNames, ['build_docs', 'doc', 'build'])
  assert.equal(config.domain, 'output.circle-artifacts.com')
  assert.equal(config.path, 'p')
  assert.equal(config.apiToken, '')
  assert.deepEqual(normalizeConfig().jobNames, ['build_docs', 'doc', 'build'])
  assert.deepEqual(normalizeConfig({'circleci-jobs': 'a, ,b '}).jobNames, ['a', 'b'])
})

test('the default entry point answers without touching the network', async () => {
  // A bad signature is rejected before any fetch happens
  assert.equal((await worker.fetch(webhook(PAYLOAD, {secret: 'wrong'}), ENV)).status, 401)

  // An unusable private key throws while importing, i.e. still before any fetch
  const response = await worker.fetch(webhook(PAYLOAD), {...ENV, PRIVATE_KEY: 'not-a-key'})
  assert.equal(response.status, 500, 'failures surface to GitHub as a failed delivery')
})

test('reuses the token and config across events in the same isolate', async () => {
  const {fetchFn, seen} = backend()
  await handle(webhook(PAYLOAD), ENV, {fetchFn})
  const first = seen.length
  await handle(webhook({...PAYLOAD, sha: 'cafe'}), ENV, {fetchFn})

  const second = seen.slice(first).map((r) => r.url)
  assert.ok(!second.some((u) => u.endsWith('/access_tokens')), 'token reused')
  assert.ok(!second.some((u) => u.includes('/contents/')), 'config reused')
  assert.ok(second.some((u) => u.includes('/statuses/')), 'but the status is still posted')
  assert.equal(second.length, 2, 'only CircleCI + the status POST')
})

test('refetches once each cache entry expires', async () => {
  const {fetchFn, seen} = backend()
  let clock = 1_000_000
  const now = () => clock
  await handle(webhook(PAYLOAD), ENV, {fetchFn, now})

  clock += CONFIG_TTL_MS + 1
  let before = seen.length
  await handle(webhook(PAYLOAD), ENV, {fetchFn, now})
  let urls = seen.slice(before).map((r) => r.url)
  assert.ok(urls.some((u) => u.includes('/contents/')), 'config refetched')
  assert.ok(!urls.some((u) => u.endsWith('/access_tokens')), 'token still valid')

  clock += TOKEN_TTL_MS + 1
  before = seen.length
  await handle(webhook(PAYLOAD), ENV, {fetchFn, now})
  urls = seen.slice(before).map((r) => r.url)
  assert.ok(urls.some((u) => u.endsWith('/access_tokens')), 'token refetched')
})

test('does not cache a failure', async () => {
  let fail = true
  const {fetchFn} = backend()
  const flaky = async (url, options) => (fail && url.endsWith('/access_tokens'))
    ? new Response('{}', {status: 500})
    : fetchFn(url, options)

  await assert.rejects(() => handle(webhook(PAYLOAD), ENV, {fetchFn: flaky}))
  fail = false
  const response = await handle(webhook(PAYLOAD), ENV, {fetchFn: flaky})
  assert.equal(response.status, 200, 'the next event retries instead of serving the failure')
})

test('a missing WEBHOOK_SECRET is a 401, not a crash', async () => {
  const {fetchFn, seen} = backend()
  for (const env of [{...ENV, WEBHOOK_SECRET: undefined}, {...ENV, WEBHOOK_SECRET: ''}]) {
    const response = await handle(webhook(PAYLOAD), env, {fetchFn})
    assert.equal(response.status, 401)
    assert.deepEqual(seen, [])
  }
})

test('the app never posts a pending status, whatever the config says', async () => {
  for (const config of [CONFIG, CONFIG + 'post-pending: true\n']) {
    clearCache()
    const {fetchFn, seen} = backend({config})
    const response = await handle(webhook({...PAYLOAD, state: 'pending'}), ENV, {fetchFn})
    assert.equal(response.status, 200)
    assert.match(await response.text(), /ignored/)
    assert.ok(!seen.some((r) => r.url.includes('/statuses/')), 'nothing posted')
    assert.ok(!seen.some((r) => r.url.includes('/artifacts')), 'and no CircleCI call')
  }
})

test('a duplicate delivery does not post the status twice', async () => {
  const {fetchFn, seen} = backend()
  const first = await handle(webhook(PAYLOAD), ENV, {fetchFn})
  const second = await handle(webhook(PAYLOAD), ENV, {fetchFn})

  assert.match(await first.text(), /^posted success/)
  assert.match(await second.text(), /already posted/)
  assert.equal(seen.filter((r) => r.url.includes('/statuses/')).length, 1, 'posted once')
})

test('but a different result for the same commit still posts', async () => {
  const {fetchFn: pendingFetch} = backend()
  await handle(webhook(PAYLOAD), ENV, {fetchFn: pendingFetch})

  // same sha and context, different artifacts (e.g. a re-run) -> must post
  const other = {url: 'https://output.circle-artifacts.com/output/job/zzz/artifacts/0/doc/other.html'}
  const {fetchFn, seen} = backend({artifacts: {items: [other]}})
  const response = await handle(webhook(PAYLOAD), ENV, {fetchFn})
  assert.match(await response.text(), /^posted success/)
  assert.equal(seen.filter((r) => r.url.includes('/statuses/')).length, 1)
})

test('the dedupe window expires', async () => {
  const {fetchFn, seen} = backend()
  let clock = 5_000_000
  const now = () => clock
  await handle(webhook(PAYLOAD), ENV, {fetchFn, now})
  clock += DEDUPE_TTL_MS + 1
  const response = await handle(webhook(PAYLOAD), ENV, {fetchFn, now})
  assert.match(await response.text(), /^posted success/)
  assert.equal(seen.filter((r) => r.url.includes('/statuses/')).length, 2)
})
