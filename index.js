// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js -o dist` to rebuild to dist/
//
// The logic itself lives in src/core.js, which is shared with the GitHub App
// front end in worker/index.js.

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

import * as core from '@actions/core'
import * as github from '@actions/github'
import { pathToFileURL } from 'node:url'
import { normalizeConfig } from './src/config.js'
import { resolveStatus } from './src/core.js'

// The context/fetch/octokit arguments exist so that tests can inject fakes;
// in production the defaults are always used.
export async function run({context = github.context, fetchFn = globalThis.fetch, getOctokit = github.getOctokit} = {}) {
  try {
    core.debug((new Date()).toTimeString())
    const payload = context.payload
    const token = core.getInput('repo-token', {required: true})
    const config = normalizeConfig({
      'artifact-path': core.getInput('artifact-path', {required: true}),
      'circleci-jobs': core.getInput('circleci-jobs', {required: false}),
      'job-title': core.getInput('job-title', {required: false}),
      'domain': core.getInput('domain'),
      'api-token': core.getInput('api-token', {required: false}),
      'post-pending': core.getInput('post-pending', {required: false}),
    })
    if (config.apiToken !== '') {
      // Keep the token out of the logs, including any future logging of it
      core.setSecret(config.apiToken)
      core.debug('Successfully read CircleCI API token')
    }

    const status = await resolveStatus({payload, config, fetchFn, log: core.debug})
    if (status === null) {
      return
    }
    core.debug(`Linking to: ${status.url}`)
    core.setOutput('url', status.url)

    const client = getOctokit(token)
    return client.rest.repos.createCommitStatus({
      repo: context.repo.repo,
      owner: context.repo.owner,
      sha: payload.sha,
      state: status.state,
      target_url: status.url,
      description: status.description,
      context: status.context
    })
  } catch (error) {
    // Keep the failure itself readable; the stack is there with debug logging
    core.debug(error.stack ?? String(error))
    core.setFailed(error.message ?? String(error))
  }
}

// Run only when invoked as the action entry point, so that index.test.js can
// import run() without executing it (this survives the ncc bundling).
/* node:coverage disable */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
/* node:coverage enable */
