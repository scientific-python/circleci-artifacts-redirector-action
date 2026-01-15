// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js` to rebuild to dist/

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

const core = require('@actions/core')
const github = require('@actions/github')
const fetch = require('node-fetch');

async function run() {
  try {
    core.debug((new Date()).toTimeString())
    const payload = github.context.payload
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    var apiToken = core.getInput('api-token', {required: false})
    var circleciJobs = core.getInput('circleci-jobs', {required: false})
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
    const state = payload.state
    core.debug(`context:    ${payload.context}`)
    core.debug(`state:      ${state}`)
    core.debug(`target_url: ${payload.target_url}`)
    // e.g., https://circleci.com/gh/mne-tools/mne-python/53315
    // e.g., https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94?utm_campaign=vcs-integration-link&utm_medium=referral&utm_source=github-build-link
    // Set the new status
    let artifacts_url = '';
    const target = payload.target_url.split('?')[0];   // strip any ?utm=…
    if (target.includes('/pipelines/circleci/')) {
      // ───── New GitHub‑App URL ───────────────────────────────────────────
      // .../pipelines/circleci/<org‑id>/<project‑id>/<pipe‑seq>/workflows/<workflow‑id>
      const workflowId = target.split('/').pop();
      core.debug(`workflow: ${workflowId}`);

      // 1. Get the jobs that belong to this workflow
      const jobsRes = await fetch(
        `https://circleci.com/api/v2/workflow/${workflowId}/job`
      );
      const jobs = await jobsRes.json();
      if (!jobs.items.length) {
        core.setFailed(`No jobs returned for workflow ${workflowId}`);
        return;
      }

      // 2. Identify and select the relevant job
      // The simplest case is when a workflow contains only a single job, just
      //  select the first entry
      let job = null;
      if (jobs.items.length === 1) {
        job = jobs.items[0];
        core.debug("Workflow contains one job.");
      }
      // If there are multiple jobs in the workflow, select the first one that
      //  matches one of the job names passed to the action.
      else {
        for (const jobItem of jobs.items) {
          core.debug(`Checking job: ${jobItem.name} against ${circleciJobNames.join(',')}`);
          if (circleciJobNames.includes(jobItem.name)) {
            job = jobItem;
            break;
          }
        }

        // In the case where no matching job is found, use the first job
        if (job == null) {
          job = jobs.items[0];
          core.debug(`No matching job found for ${circleciJobNames.join(', ')}. Using first job: ${job.name}`);
        }
      }

      // Extract the project slug and job number from the selected job
      const projectSlug = job.project_slug;  // "circleci/<org‑id>/<project‑id>"
      const jobNumber   = job.job_number;

      core.debug(`slug:  ${projectSlug}`);
      core.debug(`job#:  ${jobNumber}`);

      // 3. Construct the v2 artifacts endpoint
      artifacts_url = `https://circleci.com/api/v2/project/${projectSlug}/${jobNumber}/artifacts`;
    } else {
      // ───── Legacy OAuth URL (…/gh/<org>/<repo>/<build>) ────────────────
      const parts    = target.split('/');
      const orgId    = parts.slice(-3)[0];
      const repoId   = parts.slice(-2)[0];
      const buildId  = parts.slice(-1)[0];

      artifacts_url =
        `https://circleci.com/api/v2/project/gh/${orgId}/${repoId}/${buildId}/artifacts`;
    }
    core.debug(`Fetching JSON: ${artifacts_url}`)
    if (apiToken == null || apiToken == '') {
      apiToken = 'null'
    }
    else {
      core.debug(`Successfully read CircleCI API token ${apiToken}`)
    }
    const headers = {'Circle-Token': apiToken, 'accept': 'application/json', 'user-agent': 'curl/7.85.0'}
    // e.g., https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts
    const response = await fetch(artifacts_url, {headers})
    const artifacts = await response.json()
    core.debug(`Artifacts JSON (status=${response.status}):`)
    core.debug(artifacts)
    // e.g., {"next_page_token":null,"items":[{"path":"test_artifacts/root_artifact.md","node_index":0,"url":"https://output.circle-artifacts.com/output/job/6fdfd148-31da-4a30-8e89-a20595696ca5/artifacts/0/test_artifacts/root_artifact.md"}]}
    var url = '';
    if (artifacts.items.length > 0) {
      url = `${artifacts.items[0].url.split('/artifacts/')[0]}/artifacts/${path}`
    }
    else {
      url = payload.target_url;
    }
    // Set root domain
    var domain = core.getInput('domain')
    url = `https://${domain}/output/${url.split('/output/')[1]}`
    core.debug(`Linking to: ${url}`)
    core.debug((new Date()).toTimeString())
    core.setOutput("url", url)
    const client = github.getOctokit(token)
    var description = '';
    if (payload.state === 'pending') {
      description = 'Waiting for CircleCI ...'
    }
    else {
      description = `Link to ${path}`
    }
    var job_title = core.getInput('job-title', {required: false})
    if (job_title === '') {
      job_title = `${payload.context} artifact`
    }
    return client.rest.repos.createCommitStatus({
      repo: github.context.repo.repo,
      owner: github.context.repo.owner,
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

run()
