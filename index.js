// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js -o dist` to rebuild to dist/

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

import * as core from '@actions/core'
import * as github from '@actions/github'
import fetch from 'node-fetch'
import { pathToFileURL } from 'node:url'

// Pick the job whose artifacts should be linked. A single-job workflow is
// unambiguous; otherwise prefer a job the user asked for, and fall back to the
// first one.
export function pickJob(items, jobNames) {
  if (items.length === 1) {
    return items[0]
  }
  return items.find((job) => jobNames.includes(job.name)) ?? items[0]
}

// Turn a legacy OAuth target_url (…/gh/<org>/<repo>/<build>) into the v2
// artifacts endpoint.
export function legacyArtifactsUrl(target) {
  const [orgId, repoId, buildId] = new URL(target).pathname.split('/').slice(-3)
  return `https://circleci.com/api/v2/project/gh/${orgId}/${repoId}/${buildId}/artifacts`
}

// Build the URL to link to: the requested artifact if anything was uploaded,
// otherwise the CircleCI job itself (rewriting the domain only makes sense for
// artifact URLs).
export function redirectUrl(items, path, domain, fallback) {
  if (!items.length) {
    return fallback
  }
  // e.g., https://output.circle-artifacts.com/output/job/<uuid>/artifacts/0/doc/index.html
  const job = items[0].url.split('/output/')[1].split('/artifacts/')[0]
  return `https://${domain}/output/${job}/artifacts/${path}`
}

// The status reports whether the link is usable, not whether the CircleCI job
// passed (gh-57): a job can fail late and still upload good artifacts, and the
// job's own status already reports the failure.
export function statusFor(payloadState, hasArtifacts, path) {
  if (payloadState === 'pending') {
    return {state: payloadState, description: 'Waiting for CircleCI ...'}
  }
  if (hasArtifacts) {
    return {state: 'success', description: `Link to ${path}`}
  }
  return {state: 'failure', description: 'No artifacts found'}
}

// Fetch JSON from the CircleCI API, failing loudly on a non-2xx response.
// Without this a 404 or a rate limit surfaces as a confusing "cannot read
// properties of undefined" from the caller.
export async function fetchJson(fetchFn, url, options) {
  const response = await fetchFn(url, options)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`CircleCI API returned ${response.status} for ${url}: ${body.slice(0, 200)}`)
  }
  return response.json()
}

// The context/fetch/octokit arguments exist so that tests can inject fakes;
// in production the defaults are always used.
export async function run({context = github.context, fetchFn = fetch, getOctokit = github.getOctokit} = {}) {
  try {
    core.debug((new Date()).toTimeString())
    const payload = context.payload
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    const apiToken = core.getInput('api-token', {required: false})
    if (apiToken !== '') {
      // Keep the token out of the logs, including any future logging of it
      core.setSecret(apiToken)
      core.debug('Successfully read CircleCI API token')
    }
    // Tolerate spaces after the commas, e.g. "build_docs, doc"
    const jobNames = (core.getInput('circleci-jobs', {required: false}) || 'build_docs,doc,build')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')

    // Each job reports itself as a "ci/circleci: <name>" status context
    const contexts = jobNames.map((name) => `ci/circleci: ${name}`)
    core.debug(`Considering CircleCI jobs named: ${contexts}`)
    if (!contexts.includes(payload.context)) {
      core.debug(`Ignoring context: ${payload.context}`)
      return
    }

    core.debug(`context:    ${payload.context}`)
    core.debug(`state:      ${payload.state}`)
    core.debug(`target_url: ${payload.target_url}`)
    if (!payload.target_url) {
      // Some status events carry no URL at all, so there is nothing to link to
      core.debug('Ignoring status with no target_url')
      return
    }
    // e.g., https://circleci.com/gh/mne-tools/mne-python/53315
    // e.g., https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94?utm_campaign=vcs-integration-link&utm_medium=referral&utm_source=github-build-link
    const target = payload.target_url.split('?')[0]   // strip any ?utm=…
    let artifactsUrl = ''
    if (target.includes('/pipelines/circleci/') || target.includes('app.circleci.com/workflow/')) {
      // ───── New GitHub‑App URL ───────────────────────────────────────────
      // .../pipelines/circleci/<org‑id>/<project‑id>/<pipe‑seq>/workflows/<workflow‑id>
      // OR
      // .../workflow/<workflow-id>
      const workflowId = target.split('/').at(-1)
      core.debug(`workflow: ${workflowId}`)

      const jobs = await fetchJson(fetchFn, `https://circleci.com/api/v2/workflow/${workflowId}/job`)
      if (!jobs.items.length) {
        core.setFailed(`No jobs returned for workflow ${workflowId}`)
        return
      }

      const job = pickJob(jobs.items, jobNames)
      core.debug(`Using job ${job.name} of ${jobs.items.map((item) => item.name).join(', ')}`)
      core.debug(`slug:  ${job.project_slug}`)  // "circleci/<org‑id>/<project‑id>"
      core.debug(`job#:  ${job.job_number}`)
      artifactsUrl = `https://circleci.com/api/v2/project/${job.project_slug}/${job.job_number}/artifacts`
    } else {
      artifactsUrl = legacyArtifactsUrl(target)
    }

    core.debug(`Fetching JSON: ${artifactsUrl}`)
    // Only send a token when we have one: CircleCI rejects a bogus token with
    // a 401 even for public projects, but is happy with no token at all
    const headers = {'accept': 'application/json', 'user-agent': 'curl/7.85.0'}
    if (apiToken !== '') {
      headers['Circle-Token'] = apiToken
    }
    // e.g., https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts
    const artifacts = await fetchJson(fetchFn, artifactsUrl, {headers})
    core.debug(`Artifacts JSON: ${JSON.stringify(artifacts)}`)
    // e.g., {"next_page_token":null,"items":[{"path":"test_artifacts/root_artifact.md","node_index":0,"url":"https://output.circle-artifacts.com/output/job/6fdfd148-31da-4a30-8e89-a20595696ca5/artifacts/0/test_artifacts/root_artifact.md"}]}
    const url = redirectUrl(artifacts.items, path, core.getInput('domain'), payload.target_url)
    core.debug(`Linking to: ${url}`)
    core.debug((new Date()).toTimeString())
    core.setOutput('url', url)

    const {state, description} = statusFor(payload.state, artifacts.items.length > 0, path)
    const jobTitle = core.getInput('job-title', {required: false}) || `${payload.context} artifact`
    const client = getOctokit(token)
    return client.rest.repos.createCommitStatus({
      repo: context.repo.repo,
      owner: context.repo.owner,
      sha: payload.sha,
      state,
      target_url: url,
      description,
      context: jobTitle
    })
  } catch (error) {
    // Keep the failure itself readable; the stack is there with debug logging
    core.debug(error.stack ?? String(error))
    core.setFailed(error.message ?? String(error))
  }
}

// Run only when invoked as the action entry point, so that index.test.js can
// import run() without executing it (this survives the ncc bundling).
/* node:coverage ignore next 3 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
