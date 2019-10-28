// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.

const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    core.debug((new Date()).toTimeString())
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    const payload = github.context.payload
    if (['ci/circleci: build_docs', 'ci/circleci: doc', 'ci/circleci: build'].indexOf(payload.context) < 0) {
      core.debug('Ignoring context ' + payload.context)
      return
    }
    if (payload.state === 'pending') {
      core.debug('Ignoring pending ' + payload.context)
      return
    }
    core.debug('Processing:')
    core.debug(payload.context)
    core.debug(payload.state)
    // Set the new status
    const state = (payload.state === 'success') ? 'success' : 'neutral'
    const buildId = payload.target_url.split('?')[0].split('/').slice(-1)[0]
    const repoId = payload.repository.id
    const url = 'https://' + buildId + '-' + repoId + '-gh.circle-artifacts.com/' + path
    core.debug('Linking to:')
    core.debug(url)
    core.debug((new Date()).toTimeString())
    const client = new github.GitHub(token)
    return client.repos.createStatus({
      repo: github.context.repo.repo,
      owner: github.context.repo.owner,
      sha: payload.sha,
      state: state,
      target_url: url,
      description: 'Link to ' + path,
      context: context.payload.context + ' artifact'
    })
  } catch (error) {
    core.setFailed(error.message);
  }
}

run()
