import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { companionCommands, PROJECT_CHECK_CODE } from '../src/ext/setup-commands.js';
import { runInNewContext } from 'node:vm';

const temporary = mkdtempSync(join(tmpdir(), 'contextflow-setup-'));
const id = 'a'.repeat(32);
const commands = companionCommands(id);
try {
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const {appendFileSync}=require('node:fs');
appendFileSync('npm-calls.txt',process.argv.slice(2).join(' ')+'\\n');
if(process.argv[2]==='ci'&&process.env.CONTEXTFLOW_TEST_INSTALL_FAIL)process.exit(9);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const storeCommands = companionCommands('aemncphfnlpbhlddifhohpgegejjejfm');
  for (const file of ['docs/GETTING_STARTED.md', 'store/COMPANION.md']) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(storeCommands.setup), `${file}: 文档命令必须与连接页一致`);
  }
  for (const version of ['18.20.0', '22.4.1', '22.5.0', '22.12.0']) {
    let message = '';
    const stopped = new Error('exit');
    assert.throws(() => runInNewContext(PROJECT_CHECK_CODE, {
      process: { versions: { node: version }, exit: (code) => { assert.equal(code, 1); throw stopped; } },
      console: { error: (text) => { message = text; } }, require: () => { throw new Error('must not read project'); },
    }), (error) => error === stopped);
    assert.match(message, /22.13/);
  }
  const run = (command, directory, extra = {}) => spawnSync('/bin/sh', ['-c', command], {
    cwd: directory, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const cases = [
    ['empty', null],
    ['invalid-json', '{'],
    ['unrelated-project', JSON.stringify({ name: 'other-project', dependencies: { '@example/private-package': '1' } })],
    ['wrong-script', JSON.stringify({ name: 'contextflow', scripts: { server: 'node other.mjs' } })],
    ['missing-server', JSON.stringify({ name: 'contextflow', scripts: { server: 'node server/index.mjs' } })],
  ];
  for (const [name, manifest] of cases) {
    const directory = join(temporary, name);
    mkdirSync(directory);
    if (manifest) writeFileSync(join(directory, 'package.json'), manifest);
    const lock = '{"preserve":"unrelated lockfile"}';
    writeFileSync(join(directory, 'package-lock.json'), lock);
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(join(directory, 'node_modules/keep'), 'existing dependency');
    for (const command of Object.values(commands)) {
      const result = run(command, directory);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /目录不对/);
    }
    assert.equal(existsSync(join(directory, 'npm-calls.txt')), false, name);
    assert.equal(readFileSync(join(directory, 'package-lock.json'), 'utf8'), lock);
    assert.equal(readFileSync(join(directory, 'node_modules/keep'), 'utf8'), 'existing dependency');
  }
  const directory = join(temporary, 'ContextFlow service with spaces');
  mkdirSync(join(directory, 'server'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'contextflow', scripts: { server: 'node server/index.mjs' } }));
  writeFileSync(join(directory, 'server/index.mjs'), '');
  assert.equal(run(commands.check, directory).status, 0);
  assert.equal(run(commands.install, directory).status, 0);
  assert.equal(run(commands.pair, directory).status, 0);
  assert.equal(run(commands.revoke, directory).status, 0);
  assert.equal(readFileSync(join(directory, 'npm-calls.txt'), 'utf8'), `ci --omit=dev\nrun server\nrun pair -- ${id}\nrun pair -- --revoke ${id}\n`);
  writeFileSync(join(directory, 'npm-calls.txt'), '');
  assert.equal(run(commands.setup, directory).status, 0);
  assert.equal(readFileSync(join(directory, 'npm-calls.txt'), 'utf8'), `ci --omit=dev\nrun pair -- ${id}\nrun server\n`, '首次安装需先生成配对码，再以前台启动服务');
  writeFileSync(join(directory, 'npm-calls.txt'), '');
  assert.equal(run(commands.restart, directory).status, 0);
  assert.equal(readFileSync(join(directory, 'npm-calls.txt'), 'utf8'), 'run server\n', '重启不能重新安装或轮换配对码');
  writeFileSync(join(directory, 'npm-calls.txt'), '');
  assert.equal(run(commands.install, directory, { CONTEXTFLOW_TEST_INSTALL_FAIL: '1' }).status, 9);
  assert.equal(readFileSync(join(directory, 'npm-calls.txt'), 'utf8'), 'ci --omit=dev\n', '安装失败不能继续启动');
  assert.throws(() => companionCommands('a; echo invalid'), /Invalid/);
  console.log('安装命令：错误目录拒绝执行 npm、原有依赖不变、空格路径、正确安装配对、失败不继续通过');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
