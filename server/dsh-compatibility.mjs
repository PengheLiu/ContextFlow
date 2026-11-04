// Reading workers use a private session protocol, qualified separately from
// the model-only connection probe. Passing the latter grants no tool access.
const DESKTOP_VERSIONS = new Set(['0.2.1-rc.2', '0.2.1-rc.5']);

export function supportsDshDesktop(version) {
  return DESKTOP_VERSIONS.has(version);
}

// Eligibility to attempt a probe is an installation property, not a version
// allowlist. The owned child verifies its actual model APIs and isolation
// before the parent permits the fixed short model request.
export function canTestDshConnection(installation) {
  return installation?.available === true && installation.source === 'desktop' && !!installation.appPath;
}
