# circleci-artifacts-redirector-action

GitHub Action to add a GitHub status link to a CircleCI artifact.

## Example usage

Sample `.github/workflows/main.yml`:

```YAML
on: [status]

permissions: read-all

jobs:
  circleci_artifacts_redirector_job:
    runs-on: ubuntu-latest
    if: "${{ github.event.context == 'ci/circleci: build_doc' }}"
    permissions:
      statuses: write
    name: Run CircleCI artifacts redirector
    steps:
      - name: GitHub Action step
        id: step1
        uses: scientific-python/circleci-artifacts-redirector-action@v1  # or use hash for better security
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          api-token: ${{ secrets.CIRCLECI_TOKEN }}
          artifact-path: 0/test_artifacts/root_artifact.md
          circleci-jobs: build_doc
          job-title: Check the rendered docs here!
      - name: Check the URL
        if: github.event.status != 'pending'
        run: |
          curl --fail ${{ steps.step1.outputs.url }} | grep $GITHUB_SHA

```
- The `if: "${{ github.event.context == 'ci/circleci: build_doc' }}"`
  conditional in the `job` is helpful to limit the number of redirector
  actions that your repo will run to avoid polluting your GitHub actions
  logs. The `circleci-jobs` (below) should be labeled correspondingly.
- The `api-token` needs to be a
   [CircleCI personal API token](https://app.circleci.com/settings/user/tokens)
  or a [CircleCI project API token](https://circleci.com/docs/managing-api-tokens/#creating-a-project-api-token)
  whose value has been added to the GitHub secrets of your repository (e.g., as
  `CIRCLECI_TOKEN`), e.g. for the MNE-Python *project* this would be
  https://github.com/mne-tools/mne-python/settings/secrets/actions and for the
  *organization* it would be https://github.com/organizations/mne-tools/settings/secrets/actions (pick whichever scope makes sense for you).
- The `artifact-path` should point to an artifact path from your CircleCI
  build. This is typically whatever follows the CircleCI artifact root path,
  for example `0/test_artifacts/root_artifact.md`.
- The `circleci-jobs` is a comma-separated list of jobs to monitor, but usually
  there is a single one that you want an artifact path for.
  The default is `"build_docs,build,doc"`, which will look for any
  jobs with these names and create an artifacts link for them. If you have
  multiple jobs to consider, make sure you adjust your `if:` statement (above)
  correspondingly.
- The `job-title` corresponds to the name of the action job as it will appear
  on github. It is **not** the circle-ci job you want the artifacts for
  (this is `circleci-jobs`). This field is optional.
- The action has an outtput ``url`` that you can use in downstream steps, but
  this URL will only point to a valid artifact once the job is complete, i.e.,
  `github.event.status` is either `'success'`, `'fail'`, or (maybe) `'error'`,
  not `'pending'`.
- If you have trouble, try [enabling debugging logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/enabling-debug-logging)
  for the action by setting the secret `ACTIONS_STEP_DEBUG=true`.

> **Note**: The standard PR-to-main-repo-from-branch-in-a-fork workflow might
> not activate the action. For changes to take effect, changes might need to be
> made to to the default branch *in a repo with the action enabled*. For
> example, you could iterate directly in `master`, or in `master` of a fork.
> This seems to be a limitation of the fact that CircleCI uses the `status`
> (rather than app) API and that this is always tied to the `master`/default
> branch of a given repository.

## Limitations

Currently has (known) limitations:

- Tests do not test anything (haven't gotten around to fixing them)
- Only allows redirecting to a single file that must be configured ahead of
  time as a file (cannot be changed within the CircleCI run)

Eventually this might be fixable by a bit of work and addition of
customization options.

## Contributing

Make any changes needed to `package-lock.json` and `index.js` and open a PR.These changes will automatically be compiled into `dist/index.js` by the
[autofix.ci bot](https://autofix.ci/).

If you want to do the same work locally as the bot, use `npm install` to get
all dependencies and then call `ncc build index.js`. On Ubuntu you might
need to `export NODE_OPTIONS=--openssl-legacy-provider` before the `ncc build`
step.
