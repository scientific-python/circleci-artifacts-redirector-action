#!/usr/bin/env python3
"""Report Cloudflare Workers usage for this Worker against the free-tier quota.

Uses $CLOUDFLARE_API_TOKEN when set, otherwise the OAuth token wrangler stored
at `wrangler login`. The stored one expires within the hour and this script
cannot refresh it, so export the API token if you got tired of logging back in.
A token needs only **Account Analytics: Read** if $CLOUDFLARE_ACCOUNT_ID is also
exported, and additionally Account Settings: Read if it is not.

Usage: ./cf-usage.py [days]  (default 7)
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
DAILY_FREE_REQUESTS = 100_000  # Workers free plan, per UTC day
FREE_CPU_LIMIT_US = 10_000  # 10 ms per invocation; over it, status is exceededCpu
CONFIG = Path('~/.config/.wrangler/config/default.toml').expanduser()


def token():
    if os.environ.get('CLOUDFLARE_API_TOKEN'):
        return os.environ['CLOUDFLARE_API_TOKEN']
    if not CONFIG.exists():
        sys.exit(f'{CONFIG} does not exist; run `npx wrangler login`')
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', CONFIG.read_text())
    if not m:
        sys.exit(f'no oauth_token in {CONFIG}; run `npx wrangler login`')
    return m.group(1)


def api(url, tok, body=None):
    headers = {'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'}
    req = urllib.request.Request(url, body, headers)
    try:
        with urllib.request.urlopen(req) as fid:
            return json.load(fid)
    except urllib.error.HTTPError as exc:
        # 400 is a malformed token, 401/403 an expired or under-scoped one. A
        # traceback here reads as a bug in this script, but the usual cause is
        # simply that wrangler's stored token aged out an hour after `login`.
        if exc.code not in (400, 401, 403):
            raise
        sys.exit(
            f'Cloudflare returned {exc.code} for {url}.\n'
            'The token is invalid, expired, or lacks Account Analytics: Read. '
            'Either run `npx wrangler login` again, or export CLOUDFLARE_API_TOKEN.'
        )


def gql(tok, query, variables):
    res = api(GRAPHQL, tok, json.dumps(dict(query=query, variables=variables)).encode())
    if res.get('errors'):
        sys.exit(json.dumps(res['errors'], indent=2))
    return res['data']


QUERY = """
query($tag:string!, $start:Time!, $end:Time!, $script:string!) {
  viewer { accounts(filter:{accountTag:$tag}) {
    workersInvocationsAdaptive(limit:1000, orderBy:[date_ASC], filter:{
        datetime_geq:$start, datetime_leq:$end, scriptName:$script}) {
      dimensions { date }
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
    }
  }}
}"""

# Invocation outcomes: anything other than `success` is worth knowing about, and
# `exceededCpu` is the one the free plan's 10 ms limit actually produces.
STATUS_QUERY = """
query($tag:string!, $start:Time!, $end:Time!, $script:string!) {
  viewer { accounts(filter:{accountTag:$tag}) {
    workersInvocationsAdaptive(limit:100, filter:{
        datetime_geq:$start, datetime_leq:$end, scriptName:$script}) {
      dimensions { status }
      sum { requests }
    }
  }}
}"""


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    tok = token()

    wrangler = Path(__file__).resolve().parent.parent / 'wrangler.toml'
    script = re.search(r'^name\s*=\s*"([^"]+)"', wrangler.read_text(), re.M).group(1)
    # Looking the account up costs an extra permission -- listing accounts needs
    # Account Settings: Read, on top of the Account Analytics: Read the report
    # itself needs. Take the ID from the environment when it is there so a token
    # minted just for this can carry the single analytics permission.
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or api(
        'https://api.cloudflare.com/client/v4/accounts', tok)['result'][0]['id']

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    fmt = '%Y-%m-%dT%H:%M:%SZ'
    rows = gql(tok, QUERY, dict(
        tag=account, script=script,
        start=start.strftime(fmt), end=end.strftime(fmt),
    ))['viewer']['accounts'][0]['workersInvocationsAdaptive']
    if not rows:
        sys.exit(f'no requests to {script} in the last {days} days')

    print(f'{script}  (last {days} days, free tier = {DAILY_FREE_REQUESTS:,} req/day)\n')
    print(f'{"date":<12}{"reqs":>7}{"errs":>6}{"subreq":>8}{"cpu p50":>9}{"cpu p99":>9}'
          f'{"% of quota":>12}')
    print('-' * 63)
    for row in rows:
        n = row['sum']['requests']
        q = row['quantiles']
        print(f'{row["dimensions"]["date"]:<12}{n:>7}{row["sum"]["errors"]:>6}'
              f'{row["sum"]["subrequests"]:>8}{q["cpuTimeP50"]:>7}us{q["cpuTimeP99"]:>7}us'
              f'{100 * n / DAILY_FREE_REQUESTS:>11.3f}%')

    total = sum(row['sum']['requests'] for row in rows)
    errors = sum(row['sum']['errors'] for row in rows)
    peak = max(row['sum']['requests'] for row in rows)
    mean = total / len(rows)
    print('-' * 63)
    print(f'{len(rows)} active days | {total:,} requests | {errors} errors')
    print(f'mean {mean:,.0f}/day ({100 * mean / DAILY_FREE_REQUESTS:.3f}% of quota), '
          f'peak {peak:,} ({100 * peak / DAILY_FREE_REQUESTS:.3f}%)')
    print(f'room to grow {DAILY_FREE_REQUESTS / peak:,.0f}x before the peak day hits the cap')

    statuses = gql(tok, STATUS_QUERY, dict(
        tag=account, script=script,
        start=start.strftime(fmt), end=end.strftime(fmt),
    ))['viewer']['accounts'][0]['workersInvocationsAdaptive']
    bad = {row['dimensions']['status']: row['sum']['requests']
           for row in statuses if row['dimensions']['status'] != 'success'}
    print('invocation outcomes: ' + (', '.join(f'{k}={v}' for k, v in bad.items())
                                     if bad else 'all success'))

    # Requests are not the binding constraint at this scale; CPU per invocation is.
    worst = max(row['quantiles']['cpuTimeP99'] for row in rows)
    if worst > FREE_CPU_LIMIT_US:
        print(f'NOTE: peak cpu p99 {worst / 1000:.1f}ms exceeds the free '
              f'{FREE_CPU_LIMIT_US / 1000:.0f}ms/invocation limit; Cloudflare tolerates '
              f'infrequent overruns but kills consistent ones (error 1102)')


main()
