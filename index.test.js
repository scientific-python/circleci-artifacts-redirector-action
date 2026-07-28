import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, pickJob, legacyArtifactsUrl, redirectUrl, statusFor } from './index.js'

const INPUTS = ['artifact-path', 'repo-token', 'api-token', 'circleci-jobs', 'job-title', 'domain']
const OUTPUT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'redirector-')), 'output.txt')
const ARTIFACT = {url: 'https://output.circle-artifacts.com/output/job/abc/artifacts/0/doc/other.html'}

// Run the action against fake CircleCI/GitHub backends. `bodies` are returned
// by successive fetch() calls, and the recorded requests, the `url` output and
// the commit status that was created are handed back for inspection.
async function runAction({inputs = {}, payload = {}, bodies = [], fetchError} = {}) {
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
    return {status: 200, json: async () => bodies.shift()}
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

test('legacy CircleCI URL', async () => {
  const {requests, url, status} = await runAction({bodies: [{items: [ARTIFACT]}]})
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts')
  assert.equal(requests[0].options.headers['Circle-Token'], 'null')
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
