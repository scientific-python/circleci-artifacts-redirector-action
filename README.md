# circleci-artifacts-redirector-action

GitHub Action to add a GitHub status link to a CircleCI artifact.

## Example usage

Sample `.github/workflows/main.yml`:

```YAML
on: [status]
jobs:
  circleci_artifacts_redirector_job:
    runs-on: ubuntu-latest
    name: Run CircleCI artifacts redirector
    steps:
      - name: GitHub Action step
        id: step1
        uses: larsoner/circleci-artifacts-redirector-action@master
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          artifact-path: 0/test_artifacts/root_artifact.md
          circleci-jobs: build_doc
          job-title: Check the rendered docs here!
      - name: Check the URL
        run: |
          curl --fail ${{ steps.step1.outputs.url }} | grep $GITHUB_SHA

```

- The `artifact-path` should point to an artifact path from your CircleCI
  build. This is typically whatever follows the CircleCI artifact root path,
  for example `0/test_artifacts/root_artifact.md`.
- The `circleci-jobs` is a comma-separated list of jobs to monitor, but usually
  there is a single one that you want an artifact path for.
  The default is `"build_docs,build,doc"`, which will look for any
  jobs with these names and create an artifacts link for them.
- The `job-title` corresponds to the name of the action job as it will appear
  on github. It is **not** the circle-ci job you want the artifacts for
  (this is `circleci-jobs`). This field is optional.
- If you have trouble, try [enabling debugging logging](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/managing-a-workflow-run#enabling-debug-logging)
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

Because this action works on the `[status]` event at the repo level, it can
be difficult to test using continuous integration in the standard way
because it *always* uses the `master` version of the action.

One option is to make all changes in your own fork but in your *master*
branch. This will ensure that the *modified action* is run on each
commit push, so that you can see the results. Make sure you have
CircleCI set up to run on your fork, and GitHub actions enabled
for your fork, by visiting the following URLs with your GitHub
username substituted:

- https://app.circleci.com/projects/project-dashboard/github/<GH_USERNAME>/
- https://github.com/<GH_USERNAME>/circleci-artifacts-redirector-action/settings/actions

Then to make a PR, make sure you have done `npm install` to get all
dependencies, then `ncc build index.js`, and then open a PR to merge
changes from your fork's `master` branch to the upstream `master`.
