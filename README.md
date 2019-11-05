# circleci-artifacts-redirector

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
        uses: actions/circleci-artifacts-redirector-action@v1
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          artifact-path: 0/test_artifacts/root_artifact.md
```

The `artifact-path` should point to an artifact path from your CircleCI build.
This is typically whatever follows the CircleCI artifact root path,
for example `0/test_artifacts/root_artifact.md`.

> **Note**: The standard PR-to-main-repo-from-branch-in-a-fork workflow will
> not activate the action. For changes to take effect, changes must be made to
> a branch *in a repo with the action enabled*. Thus you can iterate directly
> in `master`, in a separate branch in your main repo, or enable the action
> in your fork for testing purposes.

## Limitations

Currently has (known) serious limitations:

- Tests do not work properly (haven't gotten around to fixing them)
- Only allows redirecting to a single file that must be configured ahead of time as a file (cannot be changed within the CircleCI run)
- Only pays attention to CircleCI jobs named `build_docs`, `build`, or `doc`
- Writes a commit status to `ci/circleci: build_docs artifact`

Eventually this stuff can all probably be fixed by a bit of work and addition of customization options. For example parsing a YAML file or something else (`setup.cfg`) to get the path would be a good start rather than just using the content of `.circleci/artifact_path` as the filename to use.
