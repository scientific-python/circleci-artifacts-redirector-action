# Security policy

This project ships two things that run in other people's infrastructure:

- the **GitHub Action** (`dist/index.js`), which runs in consumers' CI with
  their `GITHUB_TOKEN`, and
- the **GitHub App** (`worker/index.js`), a Cloudflare Worker that posts
  commit statuses to every repository the App is installed on.

A vulnerability in either affects repositories beyond this one, so please
report privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab of this
repository, then **Report a vulnerability**. Please do not open a public
issue or pull request for anything security-sensitive.

## Supported versions

The latest `v1` release of the action and the currently deployed Worker.
Older releases do not receive fixes; consumers should track `v1` (or pin a
full commit SHA and update it).
