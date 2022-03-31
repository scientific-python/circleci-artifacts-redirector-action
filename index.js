// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js` to rebuild to dist/

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

const core = require('@actions/core')
const github = require('@actions/github')

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
    core.debug('Considering CircleCI jobs named:')
    core.debug(circleciJobs)
    if (circleciJobs.indexOf(payload.context) < 0) {
      core.debug('Ignoring context:')
      core.debug(payload.context)
      return
    }
    core.debug('Processing context and state:')
    core.debug(payload.context)
    core.debug(payload.state)
    // Set the new status
    const state = payload.state
    const buildId = payload.target_url.split('?')[0].split('/').slice(-1)[0]
    const repoId = payload.repository.id
    const url = 'https://' + buildId + '-' + repoId + '-gh.circle-artifacts.com/' + path
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
