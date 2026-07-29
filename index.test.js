import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { debug, run } from './index.js'
import { pickJob, legacyArtifactsUrl, redirectUrl, statusFor, fetchJson, resolveStatus } from './src/core.js'
import { normalizeConfig } from './src/config.js'

const INPUTS = ['artifact-path', 'repo-token', 'api-token', 'circleci-jobs', 'job-title', 'domain', 'post-pending']
const OUTPUT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'redirector-')), 'output.txt')
const ARTIFACT = {url: 'https://output.circle-artifacts.com/output/job/abc/artifacts/0/doc/other.html'}

// Run the action against fake CircleCI/GitHub backends. `bodies` are returned
// by successive fetch() calls, and the recorded requests, the `url` output and
// the commit status that was created are handed back for inspection.
async function runAction({inputs = {}, payload = {}, bodies = [], fetchError, httpStatus = 200} = {}) {
  fs.writeFileSync(OUTPUT_FILE, '')
  process.env.GITHUB_OUTPUT = OUTPUT_FILE
  for (const name of INPUTS) {
    delete process.env[`INPUT_${name.toUpperCase()}`]
  }
  const all = {'artifact-path': 'doc/index.html', 'repo-token': 'gh-token', domain: 'output.circle-artifacts.com', ...inputs}
  for (const [name, value] of Object.entries(all)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value
  }

  const requests = []
  const fetchFn = async (url, options) => {
    requests.push({url, options})
    if (fetchError !== undefined) {
      throw fetchError
    }
    return {
      ok: httpStatus < 400,
      status: httpStatus,
      json: async () => bodies.shift(),
      text: async () => JSON.stringify(bodies.shift()),
    }
  }
  let status = null
  const getOctokit = () => ({rest: {repos: {createCommitStatus: async (s) => { status = s }}}})
  const context = {
    payload: {
      context: 'ci/circleci: build',
      state: 'success',
      sha: 'deadbeef',
      target_url: 'https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94',
      ...payload,
    },
    repo: {owner: 'scientific-python', repo: 'circleci-artifacts-redirector-action'},
  }
  await run({context, fetchFn, getOctokit})
  const url = fs.readFileSync(OUTPUT_FILE, 'utf8').split(os.EOL)[1]
  return {requests, url, status}
}

// Collect everything written to stdout (the ::debug::/::error:: workflow
// commands) while fn runs.
async function captureStdout(fn) {
  const written = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true }
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return written.join('')
}

test('legacy CircleCI URL', async () => {
  const {requests, url, status} = await runAction({bodies: [{items: [ARTIFACT]}]})
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts')
  assert.ok(!('Circle-Token' in requests[0].options.headers), 'no token header without an api-token')
  assert.equal(url, 'https://output.circle-artifacts.com/output/job/abc/artifacts/doc/index.html')
  assert.deepEqual(status, {
    repo: 'circleci-artifacts-redirector-action',
    owner: 'scientific-python',
    sha: 'deadbeef',
    state: 'success',
    target_url: url,
    description: 'Link to doc/index.html',
    context: 'ci/circleci: build artifact',
  })
})

test('api token, custom domain and job title', async () => {
  const {requests, url, status} = await runAction({
    inputs: {'api-token': 'circle-token', domain: 'circleci-artifacts.scientific-python.org', 'job-title': 'See the docs'},
    payload: {state: 'pending'},
    bodies: [{items: [ARTIFACT]}],
  })
  assert.equal(requests[0].options.headers['Circle-Token'], 'circle-token')
  assert.equal(url, 'https://circleci-artifacts.scientific-python.org/output/job/abc/artifacts/doc/index.html')
  assert.equal(status.description, 'Waiting for CircleCI ...')
  assert.equal(status.context, 'See the docs')
})

test('workflow URL with a single job', async () => {
  const {requests, url} = await runAction({
    payload: {target_url: 'https://app.circleci.com/workflow/wf-123?utm_source=github-build-link'},
    bodies: [{items: [{name: 'other', project_slug: 'circleci/1/2', job_number: 7}]}, {items: [ARTIFACT]}],
  })
  assert.deepEqual(requests.map(r => r.url), [
    'https://circleci.com/api/v2/workflow/wf-123/job',
    'https://circleci.com/api/v2/project/circleci/1/2/7/artifacts',
  ])
  assert.equal(url, 'https://output.circle-artifacts.com/output/job/abc/artifacts/doc/index.html')
})

test('workflow URL selects the matching job', async () => {
  const jobs = [
    {name: 'lint', project_slug: 'circleci/1/2', job_number: 7},
    {name: 'docs', project_slug: 'circleci/1/2', job_number: 8},
  ]
  const {requests} = await runAction({
    inputs: {'circleci-jobs': 'docs'},
    payload: {context: 'ci/circleci: docs', target_url: 'https://app.circleci.com/pipelines/circleci/1/2/3/workflows/wf-123'},
    bodies: [{items: jobs}, {items: [ARTIFACT]}],
  })
  assert.equal(requests[1].url, 'https://circleci.com/api/v2/project/circleci/1/2/8/artifacts')
})

test('workflow URL falls back to the first job', async () => {
  const jobs = [
    {name: 'lint', project_slug: 'circleci/1/2', job_number: 7},
    {name: 'test', project_slug: 'circleci/1/2', job_number: 8},
  ]
  const {requests} = await runAction({
    payload: {target_url: 'https://app.circleci.com/pipelines/circleci/1/2/3/workflows/wf-123'},
    bodies: [{items: jobs}, {items: [ARTIFACT]}],
  })
  assert.equal(requests[1].url, 'https://circleci.com/api/v2/project/circleci/1/2/7/artifacts')
})

test('no artifacts links to the job itself and fails', async () => {
  const {url, status} = await runAction({
    inputs: {domain: 'circleci-artifacts.scientific-python.org'},
    bodies: [{items: []}],
  })
  assert.equal(url, 'https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94')
  assert.equal(status.target_url, url)
  assert.equal(status.state, 'failure')
  assert.equal(status.description, 'No artifacts found')
})

// gh-57: the status tracks the link, not the CircleCI job
test('a failed job with artifacts still succeeds', async () => {
  const {url, status} = await runAction({
    payload: {state: 'failure'},
    bodies: [{items: [ARTIFACT]}],
  })
  assert.equal(url, 'https://output.circle-artifacts.com/output/job/abc/artifacts/doc/index.html')
  assert.equal(status.state, 'success')
  assert.equal(status.description, 'Link to doc/index.html')
})

test('a successful job without artifacts fails', async () => {
  const {status} = await runAction({payload: {state: 'success'}, bodies: [{items: []}]})
  assert.equal(status.state, 'failure')
})

test('a pending job stays pending', async () => {
  const {status} = await runAction({payload: {state: 'pending'}, bodies: [{items: []}]})
  assert.equal(status.state, 'pending')
  assert.equal(status.description, 'Waiting for CircleCI ...')
})

test('other contexts are ignored', async () => {
  const {requests, url, status} = await runAction({payload: {context: 'ci/circleci: lint'}})
  assert.deepEqual(requests, [])
  assert.equal(url, undefined)
  assert.equal(status, null)
})

test('an empty workflow fails the job', async () => {
  const {status} = await runAction({
    payload: {target_url: 'https://app.circleci.com/workflow/wf-123'},
    bodies: [{items: []}],
  })
  assert.equal(status, null)
  assert.equal(process.exitCode, 1)  // core.setFailed()
  process.exitCode = 0
})

test('a bad response fails the job', async () => {
  const {status} = await runAction({bodies: [undefined]})  // json() -> undefined
  assert.equal(status, null)
  assert.equal(process.exitCode, 1)  // core.setFailed()
  process.exitCode = 0
})

test('a thrown non-Error fails the job', async () => {
  const {status} = await runAction({fetchError: 'kaboom'})
  assert.equal(status, null)
  assert.equal(process.exitCode, 1)  // core.setFailed()
  process.exitCode = 0
})

// Unit tests for the pieces run() is built from

test('pickJob', () => {
  const lint = {name: 'lint'}
  const docs = {name: 'docs'}
  assert.equal(pickJob([lint], ['docs']), lint, 'a lone job is used even if unnamed')
  assert.equal(pickJob([lint, docs], ['docs']), docs, 'a named job wins over an earlier one')
  assert.equal(pickJob([lint, docs], ['nope']), lint, 'no match falls back to the first job')
})

test('legacyArtifactsUrl', () => {
  assert.equal(
    legacyArtifactsUrl('https://circleci.com/gh/mne-tools/mne-python/53315'),
    'https://circleci.com/api/v2/project/gh/mne-tools/mne-python/53315/artifacts',
  )
})

test('redirectUrl', () => {
  assert.equal(
    redirectUrl([ARTIFACT], 'doc/index.html', 'example.org', 'https://fallback'),
    'https://example.org/output/job/abc/artifacts/doc/index.html',
  )
  assert.equal(redirectUrl([], 'doc/index.html', 'example.org', 'https://fallback'), 'https://fallback')
})

test('statusFor', () => {
  assert.deepEqual(statusFor('pending', false, 'p'), {state: 'pending', description: 'Waiting for CircleCI ...'})
  assert.deepEqual(statusFor('failure', true, 'p'), {state: 'success', description: 'Link to p'})
  assert.deepEqual(statusFor('success', false, 'p'), {state: 'failure', description: 'No artifacts found'})
})

// Tier 1 fixes

test('the api token is masked and never logged', async () => {
  process.env.RUNNER_DEBUG = '1'  // make core.debug() actually write
  let out
  try {
    out = await captureStdout(
      () => runAction({inputs: {'api-token': 'super-secret'}, bodies: [{items: [ARTIFACT]}]}))
  } finally {
    delete process.env.RUNNER_DEBUG
  }
  assert.ok(out.includes('::add-mask::super-secret'), 'the token is registered as a secret')
  assert.ok(
    !out.split('::add-mask::super-secret').join('').includes('super-secret'),
    'the token appears nowhere else in the log',
  )
})

test('job names are trimmed', async () => {
  const {requests} = await runAction({
    inputs: {'circleci-jobs': 'build_docs, docs'},
    payload: {context: 'ci/circleci: docs'},
    bodies: [{items: [ARTIFACT]}],
  })
  assert.equal(requests.length, 1, 'a name with a leading space still matches')
})

test('a status with no target_url is ignored', async () => {
  const {requests, status} = await runAction({payload: {target_url: null}})
  assert.deepEqual(requests, [])
  assert.equal(status, null)
  assert.equal(process.exitCode, 0, 'ignored, not failed')
})

test('an HTTP error fails the job with a useful message', async () => {
  let result
  const out = await captureStdout(async () => {
    result = await runAction({httpStatus: 429, bodies: [{message: 'slow down'}]})
  })
  assert.equal(result.status, null)
  assert.equal(process.exitCode, 1)  // core.setFailed()
  process.exitCode = 0
  assert.match(out, /::error::CircleCI API returned 429 for /)
  assert.match(out, /slow down/)
})

test('fetchJson', async () => {
  const okResponse = {ok: true, status: 200, json: async () => ({items: []})}
  assert.deepEqual(await fetchJson(async () => okResponse, 'https://x'), {items: []})

  const badResponse = {ok: false, status: 404, text: async () => 'no such project'}
  await assert.rejects(
    () => fetchJson(async () => badResponse, 'https://x'),
    /returned 404 for https:\/\/x: no such project/,
    'the status and body make it into the message',
  )

  // An unreadable body should not mask the status code
  const unreadable = {ok: false, status: 500, text: async () => { throw new Error('nope') }}
  await assert.rejects(() => fetchJson(async () => unreadable, 'https://x'), /returned 500/)
})

test('resolveStatus works without a logger', async () => {
  const fetchFn = async () => ({ok: true, status: 200, json: async () => ({items: [ARTIFACT]})})
  const status = await resolveStatus({
    payload: {context: 'ci/circleci: build', state: 'success', target_url: 'https://circleci.com/gh/o/r/1'},
    config: normalizeConfig({'artifact-path': 'doc/index.html'}),
    fetchFn,
  })
  assert.equal(status.url, 'https://output.circle-artifacts.com/output/job/abc/artifacts/doc/index.html')
})

// CPU budget (see CLAUDE.md): the Worker gets 10 ms of CPU per request and the
// artifacts payload is ~1 MB for a large docs build, so no debug message may be
// built unless something is going to read it. A `toJSON` hook is a precise
// tripwire for that -- JSON.stringify() cannot serialize the payload without
// calling it -- where asserting on elapsed milliseconds would just be flaky.
const countingArtifacts = () => {
  const payload = {items: [ARTIFACT], serialized: 0}
  payload.toJSON = () => { payload.serialized++; return {items: [ARTIFACT]} }
  return payload
}

const resolveWith = (artifacts, log) => resolveStatus({
  payload: {context: 'ci/circleci: build', state: 'success', target_url: 'https://circleci.com/gh/o/r/1'},
  config: normalizeConfig({'artifact-path': 'doc/index.html'}),
  fetchFn: async () => ({ok: true, status: 200, json: async () => artifacts}),
  log,
})

test('the artifacts payload is not serialized when the log discards it', async () => {
  const artifacts = countingArtifacts()
  await resolveWith(artifacts, () => {})   // the Worker's logger
  assert.equal(artifacts.serialized, 0, 'serializing costs ~2x parsing the response')

  const bare = countingArtifacts()
  await resolveWith(bare)                  // and with no logger at all
  assert.equal(bare.serialized, 0)
})

test('a logger that resolves thunks still gets the full payload', async () => {
  const artifacts = countingArtifacts()
  const lines = []
  await resolveWith(artifacts, (m) => lines.push(typeof m === 'function' ? m() : m))
  assert.equal(artifacts.serialized, 1, 'built once, not once per line')
  assert.ok(lines.some((line) => line.startsWith('Artifacts JSON: {')), 'debugging is unaffected')
})

test('debug() only builds an expensive message when the runner wants it', async () => {
  const thunk = () => { calls++; return 'expensive' }
  let calls = 0

  delete process.env.RUNNER_DEBUG
  let out = await captureStdout(async () => debug(thunk))
  assert.equal(calls, 0, 'not built when debug logging is off')
  assert.equal(out, '')

  process.env.RUNNER_DEBUG = '1'
  try {
    out = await captureStdout(async () => {
      debug(thunk)
      debug('plain string')
    })
  } finally {
    delete process.env.RUNNER_DEBUG
  }
  assert.equal(calls, 1)
  assert.match(out, /::debug::expensive/)
  assert.match(out, /::debug::plain string/)
})

test('debug() passes plain strings through whatever the runner is doing', async () => {
  const out = await captureStdout(async () => debug('always emitted'))
  assert.match(out, /::debug::always emitted/, 'core.debug decides, as it always did')
})

test('post-pending: false skips the pending status entirely', async () => {
  const {requests, url, status} = await runAction({
    inputs: {'post-pending': 'false'},
    payload: {state: 'pending'},
  })
  assert.deepEqual(requests, [], 'and costs no CircleCI call')
  assert.equal(url, undefined)
  assert.equal(status, null)
})

test('post-pending defaults to on, and only "false" turns it off', async () => {
  for (const [value, expected] of [[undefined, 'pending'], ['true', 'pending'], ['False', null], ['false', null]]) {
    const {status} = await runAction({
      inputs: value === undefined ? {} : {'post-pending': value},
      payload: {state: 'pending'},
      bodies: [{items: []}],
    })
    assert.equal(status === null ? null : status.state, expected, `post-pending: ${value}`)
  }
})
