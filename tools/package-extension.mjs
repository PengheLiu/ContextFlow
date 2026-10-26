import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureArtifactDirectory, publishImmutableArtifacts } from './artifact-output.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1] || args[1].startsWith('--'))) throw new Error('仅支持 --output-dir <源码目录内的交付目录>。');
const release = ensureArtifactDirectory(args.length ? resolve(root, args[1]) : join(root, 'release'), root);
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-store-'));
const output = join(temporary, 'extension');
const archive = join(release, `contextflow-chrome-${version}.zip`);
const required = ['app.js', 'sw.js', 'options.js', 'options.html', 'options.css', 'privacy.html',
  'manifest.json', 'toolbar-16.png', 'toolbar-32.png', 'toolbar-48.png', 'toolbar-128.png'];

try {
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root,
    env: { ...process.env, CONTEXTFLOW_DIR: join(temporary, 'empty-config'), CONTEXTFLOW_EXT_DIR: output },
    stdio: 'inherit',
  });
  const actual = readdirSync(output).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...required].sort())) throw new Error('发布目录包含缺失或非预期文件');
  for (const name of actual) {
    const entry = lstatSync(join(output, name));
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('发布目录只能包含顶层普通文件，不能是符号链接。');
  }
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  if (manifest.key || manifest.manifest_version !== 3 || manifest.version !== version) throw new Error('商店 manifest 不符合要求');
  for (const file of actual.filter((name) => /\.(js|json|html|css)$/.test(name))) {
    const text = readFileSync(join(output, file), 'utf8');
    if (/__CONTEXTFLOW_TOKEN__|cf-test-token-|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`发布文件包含凭证残留或未替换标记：${file}`);
    }
  }
  const stagedArchive = join(temporary, 'extension.zip');
  const epoch = new Date('2000-01-01T00:00:00.000Z');
  for (const name of actual) {
    const file = join(output, name);chmodSync(file, 0o644);utimesSync(file, epoch, epoch);
  }
  execFileSync('zip', ['-X', '-q', stagedArchive, ...actual], { cwd: output, env: { ...process.env, TZ: 'UTC' } });
  const bytes = readFileSync(stagedArchive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = `contextflow-chrome-${version}.zip`;
  publishImmutableArtifacts([{ name, bytes }, { name: `${name}.sha256`, bytes: `${digest}  ${name}\n` }], { directory: release, repository: root });
  console.log(`商店 ZIP：${archive}`);
  console.log(`SHA-256：${digest}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
