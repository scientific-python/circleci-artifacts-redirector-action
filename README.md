# circleci-artifacts-redirector-action

GitHub Action to add a GitHub status link to a CircleCI artifact.

## Example usage

Sample `.github/workflows/circleci_redirect.yml`:


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
          domain:
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
- Use `domain` to set where the CircleCI artifacts are hosted. It defaults to CircleCI, but the
  [Scientific Python CircleCI proxy](https://github.com/scientific-python/circleci-proxy) can be set, too,
  as it addresses some routing issues for mystmd generated outputs.
- The status this action creates reports whether the artifact link is usable,
  **not** whether the CircleCI job passed (the CircleCI job posts its own
  status for that). So a job that fails after uploading its artifacts still
  gets a green link, and a job that passes without uploading anything gets a
  red one (see [#57](https://github.com/scientific-python/circleci-artifacts-redirector-action/issues/57)).
- Use `no-artifact-state` to change what a job that uploaded nothing posts,
  which is worth doing if that is an expected outcome for your repo — a commit
  that deliberately skips the CircleCI docs build, say. It defaults to
  `'failure'` (red); `'success'` posts a green status linking to the CircleCI
  job instead, and `'skip'` posts no status at all (and sets no `url` output).
  There is no grey option because a GitHub commit status has no neutral state:
  it is red, green, or yellow, and the yellow one would sit unresolved forever.
  With `'skip'`, note that a "Waiting for CircleCI ..." status already posted
  earlier stays yellow, so `post-pending: 'false'` usually belongs with it.
  (Not a concern under the App, which never posts a pending status at all.)
- Set `post-pending: 'false'` to skip the "Waiting for CircleCI ..." status
  that is posted while the job is still running. That halves the statuses this
  action creates, and since every status is itself a `status` event, it halves
  the workflow runs they trigger too (see
  [#27](https://github.com/scientific-python/circleci-artifacts-redirector-action/issues/27)).
  It defaults to `'true'`, so existing setups are unchanged.
- The action has an output `url` that you can use in downstream steps, but
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

## GitHub App (prototype, not yet deployed)

`worker/index.js` is a Cloudflare Worker that does the same job as the action,
but as a GitHub App reacting to `status` webhooks server-side. The point is
[#27](https://github.com/scientific-python/circleci-artifacts-redirector-action/issues/27):
with the App there is no workflow, so there are **no workflow runs at all** —
instead of one run per status event, most of which do nothing.

Instead of a workflow file, a repo using the App has
`.github/circleci-artifacts.yml`, which is the `with:` block of the old
workflow with the indentation and `repo-token` removed:

```yaml
artifact-path: 0/doc/index.html
circleci-jobs: build_docs
job-title: Check the rendered docs here!
```

Since migrating usually means `git mv`-ing the old workflow, the underscore
and `circle` spellings are accepted too — `circle-artifacts.yml`,
`circle_artifacts.yml`, `circleci_artifacts.yml`, and the `.yaml` versions of
each all work.

The config is always read from the **default branch**, so a pull request
(including one from a fork) cannot change where the link points.

Both front ends share `src/core.js` and `src/config.js`, so the two cannot
drift apart: the same resolution logic and the same option defaults serve both.

Differences from the action, by design:

- No `url` output, because there is no workflow step to consume it.
- No "Waiting for CircleCI ..." status: the app always behaves as though
  `post-pending` were `false`, since each status it posts is itself a `status`
  event, and the final status says everything the pending one did.
- Public CircleCI projects only: a private project needs an `api-token`, which
  would mean storing each repo's CircleCI token server-side.
- Duplicate deliveries are dropped: CircleCI sometimes reports the same job
  status twice, and posting an identical status twice is invisible in the UI
  but doubles the events it generates.

The action is not going away; the App is a second way to run the same code.

## Limitations

Currently has (known) limitations:

- The `on: status` event is way too broad, but there doesn't seem to be a way of limiting it.
  This leads to lots of 1-2s actions for each status update (see [#27](https://github.com/scientific-python/circleci-artifacts-redirector-action/issues/27)).
- Only allows redirecting to a single file that must be configured ahead of
  time as a file (cannot be changed within the CircleCI run)

Eventually this might be fixable by a bit of work and addition of
customization options.

## Contributing

Make any changes needed to `package-lock.json` and `index.js` and open a PR.
These changes will automatically be compiled into `dist/index.js` by the
[autofix.ci bot](https://autofix.ci/).

If you want to do the same work locally as the bot, use `npm install` to get
all dependencies and then call `ncc build index.js -o dist`.

Style-only commits are listed in `.git-blame-ignore-revs`; run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once locally to have
`git blame` skip them (GitHub's blame view uses the file automatically).

Unit tests live in `index.test.js` and use the
[Node.js test runner](https://nodejs.org/api/test.html). Run them with
`npm test` (which also lints), or `npm run coverage` to additionally write an
`lcov.info` report of the kind that CI uploads to
[Codecov](https://app.codecov.io/gh/scientific-python/circleci-artifacts-redirector-action).
