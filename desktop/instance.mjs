import { resolve } from 'node:path';

export function launchIdentity({ executable, version, build }) {
  return { executable: resolve(executable), version, build };
}

export function sameLaunch(a, b) {
  return !!a?.executable && !!b?.executable && a.executable === b.executable &&
    a.version === b.version && a.build === b.build;
}

// Missing metadata means a pre-handoff desktop may still own the lock. Do not
// silently pretend a newly installed build was opened in that case.
export function needsInstanceNotice(current, running) {
  return !sameLaunch(current, running);
}
