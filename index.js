// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.

const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    core.debug((new Date()).toTimeString())
    const context = github.context
    if (['ci/circleci: build_docs', 'ci/circleci: doc', 'ci/circleci: build'].indexOf(context.payload.context) < 0) {
      core.debug('Ignoring context ' + context.payload.context)
      return
    }
    if (context.payload.state === 'pending') {
      core.debug('Ignoring pending ' + context.payload.context)
      return
    }
    core.debug('Processing:')
    core.debug(context.payload.context)
    core.debug(context.payload.state)
    const token = core.getInput('repo-token', {required: true})
    const client = new github.GitHub(token)
    // Adapted (MIT license) from https://github.com/Financial-Times/ebi/blob/master/lib/get-contents.js
    const filepath = '.circleci/artifact_path'
    var path = ''
    try {
      const repoData = await client.repos.getContents({
        repo: context.repo.repo,
        owner: context.repo.owner,
        ref: context.payload.sha,
        path: filepath
      })
      path = Buffer.from(repoData.data.content, 'base64').toString('utf8').replace(/(\r\n|\n|\r)/gm, "")
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`404 ERROR: file '${filepath}' not found`)
      } else {
        throw error
      }
    }
    // Set the new status
    const state = (context.payload.state === 'success') ? 'success' : 'neutral'
    const buildId = context.payload.target_url.split('?')[0].split('/').slice(-1)[0]
    const repoId = context.payload.repository.id
    const url = 'https://' + buildId + '-' + repoId + '-gh.circle-artifacts.com/' + path
    core.debug('Linking to:')
    core.debug(url)
    core.debug((new Date()).toTimeString())
    return client.repos.createStatus({
      repo: context.repo.repo,
      owner: context.repo.owner,
      sha: context.payload.sha,
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
