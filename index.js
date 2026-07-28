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

// The context/fetch/octokit arguments exist so that tests can inject fakes;
// in production the defaults are always used.
export async function run({context = github.context, fetchFn = fetch, getOctokit = github.getOctokit} = {}) {
  try {
    core.debug((new Date()).toTimeString())
    const payload = context.payload
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    let apiToken = core.getInput('api-token', {required: false})
    let circleciJobs = core.getInput('circleci-jobs', {required: false})
    if (circleciJobs === '') {
      circleciJobs = 'build_docs,doc,build'
    }

    // Split circleJobs into an array of job names
    const circleciJobNames = circleciJobs.split(',')

    //  Defines a variable to help prefix each job name with ci/circleci
    const prepender = x => `ci/circleci: ${x}`
    circleciJobs = circleciJobNames.map(prepender)
    core.debug(`Considering CircleCI jobs named: ${circleciJobs}`)

    if (circleciJobs.indexOf(payload.context) < 0) {
      core.debug(`Ignoring context: ${payload.context}`)
      return
    }

    // Read out 'state' (whether CircleCI process was successful or not), then
    //  store in debug output along with the target_url
    let state = payload.state
    core.debug(`context:    ${payload.context}`)
    core.debug(`state:      ${state}`)
    core.debug(`target_url: ${payload.target_url}`)
    // e.g., https://circleci.com/gh/mne-tools/mne-python/53315
    // e.g., https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94?utm_campaign=vcs-integration-link&utm_medium=referral&utm_source=github-build-link
    // Set the new status
    let artifacts_url = ''
    const target = payload.target_url.split('?')[0]   // strip any ?utm=…
    if (target.includes('/pipelines/circleci/') || target.includes('app.circleci.com/workflow/')) {
      // ───── New GitHub‑App URL ───────────────────────────────────────────
      // .../pipelines/circleci/<org‑id>/<project‑id>/<pipe‑seq>/workflows/<workflow‑id>
      // OR
      // .../workflow/<workflow-id>
      const workflowId = target.split('/').pop()
      core.debug(`workflow: ${workflowId}`)

      // 1. Get the jobs that belong to this workflow
      const jobsRes = await fetchFn(
        `https://circleci.com/api/v2/workflow/${workflowId}/job`
      )
      const jobs = await jobsRes.json()
      if (!jobs.items.length) {
        core.setFailed(`No jobs returned for workflow ${workflowId}`)
        return
      }

      // 2. Identify and select the relevant job
      // The simplest case is when a workflow contains only a single job, just
      //  select the first entry
      let job = null
      if (jobs.items.length === 1) {
        job = jobs.items[0]
        core.debug('Workflow contains one job.')
      }
      // If there are multiple jobs in the workflow, select the first one that
      //  matches one of the job names passed to the action.
      else {
        for (const jobItem of jobs.items) {
          core.debug(`Checking job: ${jobItem.name} against ${circleciJobNames.join(',')}`)
          if (circleciJobNames.includes(jobItem.name)) {
            job = jobItem
            break
          }
        }

        // In the case where no matching job is found, use the first job
        if (job == null) {
          job = jobs.items[0]
          core.debug(`No matching job found for ${circleciJobNames.join(', ')}. Using first job: ${job.name}`)
        }
      }

      // Extract the project slug and job number from the selected job
      const projectSlug = job.project_slug  // "circleci/<org‑id>/<project‑id>"
      const jobNumber   = job.job_number

      core.debug(`slug:  ${projectSlug}`)
      core.debug(`job#:  ${jobNumber}`)

      // 3. Construct the v2 artifacts endpoint
      artifacts_url = `https://circleci.com/api/v2/project/${projectSlug}/${jobNumber}/artifacts`
    } else {
      // ───── Legacy OAuth URL (…/gh/<org>/<repo>/<build>) ────────────────
      const parts    = target.split('/')
      const orgId    = parts.slice(-3)[0]
      const repoId   = parts.slice(-2)[0]
      const buildId  = parts.slice(-1)[0]

      artifacts_url =
        `https://circleci.com/api/v2/project/gh/${orgId}/${repoId}/${buildId}/artifacts`
    }
    core.debug(`Fetching JSON: ${artifacts_url}`)
    if (apiToken == null || apiToken === '') {
      apiToken = 'null'
    }
    else {
      core.debug(`Successfully read CircleCI API token ${apiToken}`)
    }
    const headers = {'Circle-Token': apiToken, 'accept': 'application/json', 'user-agent': 'curl/7.85.0'}
    // e.g., https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts
    const response = await fetchFn(artifacts_url, {headers})
    const artifacts = await response.json()
    core.debug(`Artifacts JSON (status=${response.status}):`)
    core.debug(JSON.stringify(artifacts))
    // e.g., {"next_page_token":null,"items":[{"path":"test_artifacts/root_artifact.md","node_index":0,"url":"https://output.circle-artifacts.com/output/job/6fdfd148-31da-4a30-8e89-a20595696ca5/artifacts/0/test_artifacts/root_artifact.md"}]}
    let url = ''
    const hasArtifacts = artifacts.items.length > 0
    if (hasArtifacts) {
      url = `${artifacts.items[0].url.split('/artifacts/')[0]}/artifacts/${path}`
      // Set root domain
      const domain = core.getInput('domain')
      url = `https://${domain}/output/${url.split('/output/')[1]}`
    }
    else {
      // Nothing was uploaded, so the best we can do is link to the job itself.
      // (Rewriting the domain only makes sense for artifact URLs.)
      url = payload.target_url
    }
    core.debug(`Linking to: ${url}`)
    core.debug((new Date()).toTimeString())
    core.setOutput('url', url)
    const client = getOctokit(token)
    // The status reports whether the link is usable, not whether the CircleCI
    // job passed (gh-57): a job can fail late and still upload good artifacts,
    // and the job's own status already reports the failure.
    let description = ''
    if (payload.state === 'pending') {
      description = 'Waiting for CircleCI ...'
    }
    else if (hasArtifacts) {
      state = 'success'
      description = `Link to ${path}`
    }
    else {
      state = 'failure'
      description = 'No artifacts found'
    }
    let job_title = core.getInput('job-title', {required: false})
    if (job_title === '') {
      job_title = `${payload.context} artifact`
    }
    return client.rest.repos.createCommitStatus({
      repo: context.repo.repo,
      owner: context.repo.owner,
      sha: payload.sha,
      state: state,
      target_url: url,
      description: description,
      context: job_title
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}

// Run only when invoked as the action entry point, so that index.test.js can
// import run() without executing it (this survives the ncc bundling).
/* node:coverage ignore next 3 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
