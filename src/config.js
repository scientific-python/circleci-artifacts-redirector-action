// The options accepted by both front ends: the GitHub Action reads them from
// workflow inputs, the GitHub App from .github/circleci-artifacts.yml. Keep the
// defaults here in sync with action.yml (index.test.js checks that they match).

export const DEFAULT_JOBS = 'build_docs,doc,build'
export const DEFAULT_DOMAIN = 'output.circle-artifacts.com'

// What to post when the job uploaded nothing. `pending` is not offered on
// purpose: a commit status has no neutral/grey state, and the yellow one would
// sit there unresolved forever.
export const NO_ARTIFACT_STATES = ['failure', 'success', 'skip']

function noArtifactState(value) {
  const state = value.toLowerCase() || 'failure'
  if (!NO_ARTIFACT_STATES.includes(state)) {
    throw new Error(`no-artifact-state must be one of ${NO_ARTIFACT_STATES.join(', ')}, got '${value}'`)
  }
  return state
}

// Turn raw string options into the shape the resolver wants. Missing values
// fall back to the defaults, so callers can pass whatever they happen to have.
export function normalizeConfig(raw = {}) {
  const get = (name) => (raw[name] ?? '').toString().trim()
  return {
    // Tolerate spaces after the commas, e.g. "build_docs, doc"
    jobNames: (get('circleci-jobs') || DEFAULT_JOBS)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
    path: get('artifact-path'),
    domain: get('domain') || DEFAULT_DOMAIN,
    jobTitle: get('job-title'),
    apiToken: get('api-token'),
    // Only a literal "false" turns it off, so existing users keep the
    // "Waiting for CircleCI ..." status they have always had
    postPending: get('post-pending').toLowerCase() !== 'false',
    noArtifactState: noArtifactState(get('no-artifact-state')),
  }
}

// A deliberately small parser for the flat "key: value" config file. The file
// is the `with:` block of the old workflow, so every value is a scalar; if that
// ever stops being true this should become a real YAML dependency.
export function parseConfig(text) {
  const config = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    const comment = value.indexOf(' #')
    if (comment !== -1 && !value.startsWith('"') && !value.startsWith("'")) {
      value = value.slice(0, comment).trim()
    }
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    config[key] = value
  }
  return config
}
