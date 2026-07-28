// Everything both front ends share: given a GitHub `status` event payload and
// the options for a repo, work out which commit status to post.
//
// This module deliberately uses nothing Node-specific -- only the global fetch
// -- so that it also runs in a Cloudflare Worker (see worker/index.js).

// Pick the job whose artifacts should be linked. A single-job workflow is
// unambiguous; otherwise prefer a job the user asked for, and fall back to the
// first one.
export function pickJob(items, jobNames) {
  if (items.length === 1) {
    return items[0]
  }
  return items.find((job) => jobNames.includes(job.name)) ?? items[0]
}

// Turn a legacy OAuth target_url (…/gh/<org>/<repo>/<build>) into the v2
// artifacts endpoint.
export function legacyArtifactsUrl(target) {
  const [orgId, repoId, buildId] = new URL(target).pathname.split('/').slice(-3)
  return `https://circleci.com/api/v2/project/gh/${orgId}/${repoId}/${buildId}/artifacts`
}

// Build the URL to link to: the requested artifact if anything was uploaded,
// otherwise the CircleCI job itself (rewriting the domain only makes sense for
// artifact URLs).
export function redirectUrl(items, path, domain, fallback) {
  if (!items.length) {
    return fallback
  }
  // e.g., https://output.circle-artifacts.com/output/job/<uuid>/artifacts/0/doc/index.html
  const job = items[0].url.split('/output/')[1].split('/artifacts/')[0]
  return `https://${domain}/output/${job}/artifacts/${path}`
}

// The status reports whether the link is usable, not whether the CircleCI job
// passed (gh-57): a job can fail late and still upload good artifacts, and the
// job's own status already reports the failure.
export function statusFor(payloadState, hasArtifacts, path) {
  if (payloadState === 'pending') {
    return {state: payloadState, description: 'Waiting for CircleCI ...'}
  }
  if (hasArtifacts) {
    return {state: 'success', description: `Link to ${path}`}
  }
  return {state: 'failure', description: 'No artifacts found'}
}

// Fetch JSON from the CircleCI API, failing loudly on a non-2xx response.
// Without this a 404 or a rate limit surfaces as a confusing "cannot read
// properties of undefined" from the caller.
export async function fetchJson(fetchFn, url, options) {
  const response = await fetchFn(url, options)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`CircleCI API returned ${response.status} for ${url}: ${body.slice(0, 200)}`)
  }
  return response.json()
}

// Work out the artifacts endpoint for a status target_url, which comes in two
// flavours depending on how the project is connected to GitHub.
export async function artifactsUrlFor(target, jobNames, fetchFn, log) {
  if (target.includes('/pipelines/circleci/') || target.includes('app.circleci.com/workflow/')) {
    // ───── New GitHub‑App URL ───────────────────────────────────────────
    // .../pipelines/circleci/<org‑id>/<project‑id>/<pipe‑seq>/workflows/<workflow‑id>
    // OR
    // .../workflow/<workflow-id>
    const workflowId = target.split('/').at(-1)
    log(`workflow: ${workflowId}`)
    const jobs = await fetchJson(fetchFn, `https://circleci.com/api/v2/workflow/${workflowId}/job`)
    if (!jobs.items.length) {
      throw new Error(`No jobs returned for workflow ${workflowId}`)
    }
    const job = pickJob(jobs.items, jobNames)
    log(`Using job ${job.name} of ${jobs.items.map((item) => item.name).join(', ')}`)
    return `https://circleci.com/api/v2/project/${job.project_slug}/${job.job_number}/artifacts`
  }
  // ───── Legacy OAuth URL (…/gh/<org>/<repo>/<build>) ────────────────
  return legacyArtifactsUrl(target)
}

// The whole job: from a status payload plus config, produce the commit status
// to create, or null when this event is none of our business. Throws when
// CircleCI cannot be reached or returns something unusable.
export async function resolveStatus({payload, config, fetchFn = globalThis.fetch, log = () => {}}) {
  // Each job reports itself as a "ci/circleci: <name>" status context
  const contexts = config.jobNames.map((name) => `ci/circleci: ${name}`)
  if (!contexts.includes(payload.context)) {
    log(`Ignoring context: ${payload.context}`)
    return null
  }
  if (payload.state === 'pending' && !config.postPending) {
    // Skipping these halves the statuses posted, and every status posted is
    // itself a status event that comes back around (gh-27)
    log('Ignoring pending status: post-pending is off')
    return null
  }
  if (!payload.target_url) {
    // Some status events carry no URL at all, so there is nothing to link to
    log('Ignoring status with no target_url')
    return null
  }
  log(`state: ${payload.state}, target_url: ${payload.target_url}`)

  const target = payload.target_url.split('?')[0]   // strip any ?utm=…
  const artifactsUrl = await artifactsUrlFor(target, config.jobNames, fetchFn, log)
  log(`Fetching JSON: ${artifactsUrl}`)
  // Only send a token when we have one: CircleCI rejects a bogus token with
  // a 401 even for public projects, but is happy with no token at all
  const headers = {'accept': 'application/json', 'user-agent': 'curl/7.85.0'}
  if (config.apiToken !== '') {
    headers['Circle-Token'] = config.apiToken
  }
  const artifacts = await fetchJson(fetchFn, artifactsUrl, {headers})
  log(`Artifacts JSON: ${JSON.stringify(artifacts)}`)

  const url = redirectUrl(artifacts.items, config.path, config.domain, payload.target_url)
  const {state, description} = statusFor(payload.state, artifacts.items.length > 0, config.path)
  return {
    url,
    state,
    description,
    context: config.jobTitle || `${payload.context} artifact`,
  }
}
