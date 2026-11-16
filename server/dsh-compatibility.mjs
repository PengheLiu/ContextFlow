import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const DSH_LEGACY_WEB_VERSION = '0.1.0-rc.6';

// The bundle layout is only eligibility to start a worker. The child verifies
// its boot and isolation contracts, then the parent validates the session API.
export function dshDesktopResources(appPath) {
  if (typeof appPath !== 'string' || !isAbsolute(appPath)) return null;
  const resources = join(appPath, 'Contents/Resources');
  const executable = join(appPath, 'Contents/MacOS/DeepSeek Harness');
  const archive = join(resources, 'app.asar');
  const primaryRuntime = join(resources, 'runtime/primary-runtime');
  const pnpm = join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs');
  const nodeBin = join(resources, 'runtime/bin');
  try {
    accessSync(executable, constants.X_OK);
    if (![executable, archive, pnpm].every(path => statSync(path).isFile()) || !statSync(nodeBin).isDirectory()) return null;
  } catch { return null; }
  return { executable, runtimeDir: join(archive, 'dsh'), primaryRuntime, pnpm, nodeBin };
}

// Eligibility to attempt a probe is an installation property, not a version
// allowlist. The owned child verifies its actual model APIs and isolation
// before the parent permits the fixed short model request.
export function canTestDshConnection(installation) {
  return installation?.available === true && installation.source === 'desktop' && !!installation.appPath;
}
