#!/usr/bin/env python3
"""Explain why a pull request has no CircleCI artifact status.

The usual answer is that the contributor follows their own fork on CircleCI.
CircleCI then builds the PR under *their* org and posts the commit statuses to
the fork, and since commit statuses are per-repository the upstream PR never
sees them -- so neither front end of this project ever receives an event, and
there is nothing for it to react to. CircleCI documents the behaviour: "if you
are following your fork on CircleCI, we will only build on that fork and not
the parent, so the parent's PR will not get status updates."

Usage: ./diagnose-pr.py <org>/<repo> <number>
       ./diagnose-pr.py https://github.com/scipy/scipy/pull/26027

Exits non-zero when it finds a PR that should have been built and was not, so
it also works as a check. Every endpoint it uses is public and unauthenticated;
set $GITHUB_TOKEN or $GH_TOKEN to escape GitHub's 60-requests-per-hour
anonymous limit.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

GITHUB = 'https://api.github.com'
CIRCLECI = 'https://circleci.com/api/v2'
UA = 'circleci-artifacts-redirector-diagnose-pr'


def get(url, headers=None):
    """Fetch JSON, mapping a 404 to None so a missing project is not an error.

    CircleCI answers 404 for a project it has never heard of but 200 with an
    empty list for one it knows and has not built, and both mean "not building"
    here, so the caller should not have to care which it got.
    """
    req = urllib.request.Request(url, headers={'user-agent': UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req) as fid:
            return json.load(fid)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        if exc.code in (401, 403):
            sys.exit(
                f'{url} returned {exc.code}. For GitHub that is usually the '
                'anonymous rate limit; export GITHUB_TOKEN to raise it.')
        raise


def pipelines(slug, branch):
    """Pipelines CircleCI ran for one branch of one project, newest first."""
    url = f'{CIRCLECI}/project/{slug}/pipeline?branch={urllib.parse.quote(branch, safe="")}'
    return (get(url) or {}).get('items', [])


def report(label, slug, branch, items, sha):
    """Print what one project did with one branch, and say if it built `sha`.

    Returns the pipelines that built this exact commit. Callers branch on the
    emptiness of `items` and of this -- never on the printed text, which is
    non-empty even when nothing was built.
    """
    print(f'{label:<10}gh/{slug}  branch {branch}')
    exact = [item for item in items if item['vcs']['revision'] == sha]
    if not items:
        print(f'{"":<10}no pipelines')
        return exact
    newest = (exact or items)[0]
    states = ', '.join(sorted({item['state'] for item in items}))
    print(f'{"":<10}{len(items)} pipeline(s) [{states}], newest #{newest["number"]} '
          f'{newest["state"]} at {newest["vcs"]["revision"][:10]} '
          f'({newest["created_at"]})')
    return exact


def parse_args(argv):
    if len(argv) == 1:
        match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', argv[0])
        if not match:
            sys.exit(__doc__)
        return match.group(1), match.group(2)
    if len(argv) == 2:
        return argv[0], argv[1]
    sys.exit(__doc__)


ADVICE = """\
Nothing can fix this from {base}: CircleCI chose where to build before any
status existed, so the redirector (action or App) never receives an event at
all. The contributor has to stop following their fork. Paste-ready:

  CircleCI is building this PR under your own CircleCI org rather than
  {base}'s, because your fork {head} is set up as a project
  on CircleCI. CircleCI builds only one of the two: "if you are following your
  fork on CircleCI, we will only build on that fork and not the parent, so the
  parent's PR will not get status updates." Commit statuses are per-repository,
  so yours land on your fork and this PR shows none -- including the link to
  the built docs.

  To fix it, unfollow (or delete) the {head} project at
  https://app.circleci.com/, and your PRs will build under
  {base} like everyone else's. You can follow
  {base} itself if you want to watch the runs.
"""

# Same symptom, different causes, so list what to look at rather than blaming
# the fork on no evidence -- a false accusation here costs a contributor a
# pointless trip through CircleCI's settings.
NEITHER = """\
PROBLEM: neither project has a pipeline for this PR, so this is not the
followed-fork case. The usual causes are:
  - the push is recent and CircleCI has not created the pipeline yet
  - "Build forked pull requests" is off for the upstream project: check
    https://circleci.com/api/v1.1/project/github/{base}/settings
    for build-fork-prs (needs a CircleCI token)
  - the upstream project uses CircleCI's GitHub App integration rather than
    OAuth -- App pipelines are never built on forks, and installing the
    CircleCI App is therefore never the fix
  - the config errored, so no workflow ran: see the project on
    https://app.circleci.com/
"""


def main():
    repo, number = parse_args(sys.argv[1:])
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    pr = get(f'{GITHUB}/repos/{repo}/pulls/{number}',
             {'authorization': f'Bearer {token}'} if token else None)
    if pr is None:
        sys.exit(f'no such pull request: {repo}#{number}')

    base, head = pr['base']['repo']['full_name'], pr['head']['repo']['full_name']
    ref, sha = pr['head']['ref'], pr['head']['sha']
    print(f'{base}#{number}  ({pr["state"]})')
    print(f'head      {head} @ {ref}  {sha}\n')

    # A same-repo PR is built under its own branch name rather than pull/N, and
    # cannot hit this bug at all: there is no second project to take the build.
    upstream_branch = f'pull/{number}' if head != base else ref
    upstream = pipelines(f'gh/{base}', upstream_branch)
    upstream_exact = report('upstream', base, upstream_branch, upstream, sha)
    if head == base:
        print('\nSame-repo PR, so the followed-fork problem cannot apply here.')
        return 0 if upstream_exact else 1

    fork = pipelines(f'gh/{head}', ref)
    fork_exact = report('fork', head, ref, fork, sha)

    if upstream_exact:
        # The fork may be followed as well, which wastes the contributor's
        # credits and confuses them, but it is not why a status is missing.
        print('\nOK: the upstream project built this commit, so a missing '
              'artifact status is something else -- compare circleci-jobs in '
              'the config against the job names on the PR.')
        return 0
    if fork:
        print(f'\nPROBLEM: CircleCI built this PR under gh/{head}, '
              f'not under gh/{base}.')
        if not fork_exact:
            print('(No fork pipeline matches this exact head commit, but the '
                  'fork is building this branch, which is the same cause.)')
        print()
        print(ADVICE.format(base=base, head=head))
        return 1
    print()
    print(NEITHER.format(base=base))
    return 1


sys.exit(main())
