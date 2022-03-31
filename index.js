// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js` to rebuild to dist/

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

const core = require('@actions/core')
const github = require('@actions/github')
const request = require('@octokit/request');

async function run() {
  try {
    core.debug((new Date()).toTimeString())
    const payload = github.context.payload
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    var circleciJobs = core.getInput('circleci-jobs', {required: false})
    if (circleciJobs === '') {
      circleciJobs = 'build_docs,doc,build'
    }
    const prepender = x => 'ci/circleci: ' + x
    circleciJobs = circleciJobs.split(',').map(prepender)
    core.debug(`Considering CircleCI jobs named: ${circleciJobs}`)
    if (circleciJobs.indexOf(payload.context) < 0) {
      core.debug(`Ignoring context: ${payload.context}`)
      return
    }
    const state = payload.state
    core.debug(`context:    ${payload.context}`)
    core.debug(`state:      ${state}`)
    core.debug(`target_url: ${payload.target_url}`)
    // e.g., https://circleci.com/gh/larsoner/circleci-artifacts-redirector-action/94?utm_campaign=vcs-integration-link&utm_medium=referral&utm_source=github-build-link
    // Set the new status
    const parts = payload.target_url.split('?')[0].split('/')
    const orgId = parts.slice(-3)[0]
    const repoId = parts.slice(-2)[0]
    const buildId = parts.slice(-1)[0]
    core.debug(`org:   ${orgId}`)
    core.debug(`repo:  ${repoId}`)
    core.debug(`build: ${buildId}`)
    // Get the URLs
    const artifacts_url = 'https://circleci.com/api/v2/project/gh/' + orgId + '/' + repoId + '/' + buildId + '/artifacts'
    core.debug(`Fetching JSON: ${artifacts_url}`)
    // e.g., https://circleci.com/api/v2/project/gh/larsoner/circleci-artifacts-redirector-action/94/artifacts
    var artifacts = ''
    request.request(artifacts_url, {json: true}, (error, res, body) => {
      if (error || res.statusCode != 200) {
        core.error(`JSON fetching error (${res.statusCode}):\n${error}`)
        return
      }
      artifacts = body
    })
    core.debug('Artifacts JSON:')
    core.debug(artifacts)
    const url = artifacts_url  // TODO: WRONG
    core.debug('Linking to:')
    core.debug(url)
    core.debug((new Date()).toTimeString())
    core.setOutput("url", url);
    const client = new github.GitHub(token)
    var description = '';
    if (payload.state === 'pending') {
      description = 'Waiting for CircleCI ...'
    }
    else {
      description = 'Link to ' + path
    }
    var job_title = core.getInput('job-title', {required: false})
    if (job_title === '') {
      job_title = payload.context + ' artifact'
    }
    return client.repos.createStatus({
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
