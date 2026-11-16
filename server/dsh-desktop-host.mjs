// Launcher for the runtime bundled with DeepSeek Harness Desktop.
// It keeps the desktop profile, model selection, authentication and tools, while
// excluding background scheduling from this ContextFlow-owned worker.
import { createRequire, registerHooks } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin] = process.argv.slice(2);
const requireRuntime = createRequire(join(runtimeDir, 'package.json'));
const incompatible = () => Object.assign(new Error('Incompatible bundled Desktop reading worker'), { code: 'DSH_DESKTOP_UNSUPPORTED' });
function bundledEntry(name) {
  const entry = realpathSync(requireRuntime.resolve(name));
  if (!entry.startsWith(realpathSync(runtimeDir) + sep)) throw incompatible();
  return entry;
}
const fromRuntime = name => import(pathToFileURL(bundledEntry(name)).href);

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

async function mountLegacyOffice(ctx) {
  const [officeSkills, workspaceDependencies, { resolveDshHome }] = await Promise.all([
    fromRuntime('@deepseek-ai/dsh-skill-office'),
    fromRuntime('@deepseek-ai/dsh-tool-workspace-dependencies'),
    fromRuntime('@deepseek-ai/dsh-home-paths'),
  ]);
  await ctx.plugin(workspaceDependencies, {
    runtimeDir, source: primaryRuntime, root: join(resolveDshHome(), 'dsh-runtimes/dsh-primary-runtime'),
  });
  const archive = dirname(realpathSync(runtimeDir));
  const manifest = bundledEntry('@deepseek-ai/libreoffice-kit/package.json');
  const packageRoot = dirname(join(`${archive}.unpacked`, relative(archive, manifest)));
  await ctx.plugin(officeSkills, {
    assetRoot: join(dirname(primaryRuntime), 'office-skills'),
    node: join(primaryRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    cli: join(packageRoot, 'lib/cli.js'),
  });
}

async function main() {
  const stateDir = process.env.CONTEXTFLOW_DSH_STATE_DIR;
  if (!stateDir || !isAbsolute(stateDir)) throw Error('Missing private worker storage');
  process.env.DSH_PRIMARY_RUNTIME = primaryRuntime;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  installOfficeResolution();
  const [{ loadLayeredEnv, loadProfileDirectory, composeEntries, reportSkippedBundles }, { runProfile }] = await Promise.all([
    fromRuntime('@deepseek-ai/dsh-app-boot'), fromRuntime('@deepseek-ai/dsh/profile-boot'),
  ]).catch(() => { throw incompatible(); });
  if (![loadLayeredEnv, loadProfileDirectory, composeEntries, reportSkippedBundles, runProfile].every(fn => typeof fn === 'function')) throw incompatible();
  const installAnchor = bundledEntry('@deepseek-ai/dsh/package.json');
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor);
  if (!Array.isArray(profile?.layers) || profile.layers.some(layer => !Array.isArray(layer.patches))) throw incompatible();
  const rows = composeEntries(profile.layers.map(layer => layer.patches));
  const hasPlugin = (id, name) => rows.some(row => row.id === id && row.name === `@deepseek-ai/${name}`);
  if (!hasPlugin('session-persistence-jsonl', 'dsh-session-persistence-jsonl')
    || !hasPlugin('storage-json', 'dsh-storage-json')
    || !hasPlugin('session-query-sqlite', 'dsh-session-query-sqlite')
    || !hasPlugin('attachment-local', 'dsh-attachment-local')) throw incompatible();
  const patchFiles = [fileURLToPath(new URL('./dsh-desktop.patch.yml', import.meta.url))];
  if (hasPlugin('office-kit', 'dsh-office-kit')) patchFiles.push(fileURLToPath(new URL('./dsh-desktop-office.patch.yml', import.meta.url)));
  const profileProvidesOffice = hasPlugin('skill-office', 'dsh-skill-office');
  reportSkippedBundles('dsh', profile);
  const application = runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: { profile, installAnchor },
    patchFiles,
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
  // Verify the mounted service state before handing a URL to the parent. An
  // updated host must never store article history in the user's Desktop data.
  const query = ctx.get('sessionQuery');
  const officeKit = ctx.get('officeKit');
  const privateRoot = (path, ...parts) => typeof path === 'string' && resolve(path) === resolve(stateDir, ...parts);
  if (ctx.get('schedule') !== undefined || ctx.get('productTelemetry') !== undefined
    || !privateRoot(ctx.get('sessionPersistence')?.root, 'sessions')
    || !privateRoot(ctx.get('storage.backend.json')?.root, 'storage')
    || !privateRoot(ctx.get('attachments')?.root, 'attachments', 'v1')
    || query?.config?.path !== ':memory:' || query.config.openAt !== 'never'
    || officeKit && !privateRoot(officeKit.outputDirectory, 'office-outputs')
    || typeof ctx.connection?.authenticatedUrl !== 'function' || ctx.webServer?.protocol !== 'http:'
    || !Number.isInteger(ctx.webServer.port) || ctx.webServer.port < 1 || ctx.webServer.port > 65535) throw incompatible();
  if (!profileProvidesOffice) await mountLegacyOffice(ctx);
  if (process.connected) process.send({ type: 'ready', profile: 'desktop', contract: 1, isolatedState: true, backgroundScheduling: false,
    url: ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`) });
}

main().catch(error => {
  // Plugin diagnostics can contain configuration secrets. Send only a fixed
  // startup failure to the parent, which offers a user-facing recovery hint.
  if (process.connected) process.send({ type: 'fatal', code: error?.code === 'DSH_DESKTOP_UNSUPPORTED' ? error.code : 'DSH_DESKTOP_START' }, () => process.exit(1));
  else process.exit(1);
});
