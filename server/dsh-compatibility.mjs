// Reading workers use a private session protocol, qualified separately from
// the model-only connection probe. Passing the latter grants no tool access.
export const DSH_PROFILE_OFFICE_VERSION = '0.2.2-rc.2';
export const DSH_LEGACY_WEB_VERSION = '0.1.0-rc.6';
const DESKTOP_VERSIONS = new Set(['0.2.1-rc.2', '0.2.1-rc.5', DSH_PROFILE_OFFICE_VERSION]);

export function supportsDshDesktop(version) {
  return DESKTOP_VERSIONS.has(version);
}

// Eligibility to attempt a probe is an installation property, not a version
// allowlist. The owned child verifies its actual model APIs and isolation
// before the parent permits the fixed short model request.
export function canTestDshConnection(installation) {
  return installation?.available === true && installation.source === 'desktop' && !!installation.appPath;
}
