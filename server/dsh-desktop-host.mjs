// Version-pinned launcher for the runtime bundled with DeepSeek Harness Desktop.
// It keeps the desktop profile, model selection, authentication and tools, while
// excluding background scheduling from this ContextFlow-owned worker.
import { createRequire, registerHooks } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin] = process.argv.slice(2);
const requireRuntime = createRequire(join(runtimeDir, 'package.json'));
const fromRuntime = name => import(pathToFileURL(requireRuntime.resolve(name)).href);

// Native Office executables must retain the physical resource paths provided by
// the desktop bundle, rather than paths inside Electron's app.asar archive.
function installOfficeResolution() {
  if (basename(dirname(runtimeDir)) !== 'app.asar') return;
  const root = realpathSync(runtimeDir), archive = dirname(root);
  const source = pathToFileURL(join(root, 'node_modules/@deepseek-ai/libreoffice-kit-')).href;
  const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), 'node_modules/@deepseek-ai/libreoffice-kit-')).href;
  registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (!resolved.url.startsWith('file:')) return resolved;
    if (!/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/.test(specifier)
      && !/\/node_modules\/@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\//.test(new URL(resolved.url).pathname)) return resolved;
    const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href;
    if (!canonical.startsWith(source)) {
      if (canonical.startsWith(pathToFileURL(archive + '/').href)) throw Error('Invalid bundled Office engine location');
      return resolved;
    }
    return { ...resolved, url: pathToFileURL(realpathSync(fileURLToPath(destination + canonical.slice(source.length)))).href };
  } });
}

async function main() {
  if (!process.env.CONTEXTFLOW_DSH_STATE_DIR || !isAbsolute(process.env.CONTEXTFLOW_DSH_STATE_DIR)) {
    throw Error('Missing private worker storage');
  }
  installOfficeResolution();
  const [{ loadLayeredEnv, loadProfileDirectory, reportSkippedBundles }, { runProfile }, { resolveDshHome }] = await Promise.all([
    fromRuntime('@deepseek-ai/dsh-app-boot'), fromRuntime('@deepseek-ai/dsh/profile-boot'), fromRuntime('@deepseek-ai/dsh-home-paths'),
  ]);
  const installAnchor = requireRuntime.resolve('@deepseek-ai/dsh/package.json');
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor);
  reportSkippedBundles('dsh', profile);
  const application = runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: { profile, installAnchor },
    patchFiles: [fileURLToPath(new URL('./dsh-desktop.patch.yml', import.meta.url))],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: {
      ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${nodeBin}${delimiter}${process.env.PATH || ''}`,
    } },
  });
  let stopping;
  const stop = () => stopping ||= (async () => {
    await (await application.catch(() => null))?.shutdown.shutdown(0);
    if (process.connected) process.disconnect();
  })();
  process.once('disconnect', stop);
  process.on('message', message => { if (message?.type === 'shutdown') void stop(); });
  const { ctx } = await application;
  // Fail before readiness if an incompatible runtime ignores our final overlay.
  if (ctx.get('schedule') !== undefined) throw Error('Background scheduling was not disabled');
  const [officeSkills, workspaceDependencies] = await Promise.all([
    fromRuntime('@deepseek-ai/dsh-skill-office'), fromRuntime('@deepseek-ai/dsh-tool-workspace-dependencies'),
  ]);
  await ctx.plugin(workspaceDependencies, {
    runtimeDir, source: primaryRuntime, root: join(resolveDshHome(), 'dsh-runtimes/dsh-primary-runtime'),
  });
  const archive = dirname(realpathSync(runtimeDir));
  const manifest = requireRuntime.resolve('@deepseek-ai/libreoffice-kit/package.json');
  const packageRoot = dirname(join(`${archive}.unpacked`, relative(archive, manifest)));
  await ctx.plugin(officeSkills, {
    assetRoot: join(dirname(primaryRuntime), 'office-skills'),
    node: join(primaryRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    cli: join(packageRoot, 'lib/cli.js'),
  });
  if (process.connected) process.send({ type: 'ready', profile: 'desktop', backgroundScheduling: false,
    url: ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`) });
}

main().catch(() => {
  // Plugin diagnostics can contain configuration secrets. Send only a fixed
  // startup failure to the parent, which offers a user-facing recovery hint.
  if (process.connected) process.send({ type: 'fatal' }, () => process.exit(1));
  else process.exit(1);
});
