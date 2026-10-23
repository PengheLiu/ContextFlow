import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detect } from '../server/agent.mjs';

const root = mkdtempSync(join(tmpdir(), 'cf-dsh-detect-'));
const previous = { PATH: process.env.PATH, HOME: process.env.HOME, CONTEXTFLOW_DSH_BIN: process.env.CONTEXTFLOW_DSH_BIN };
try {
  const bin = join(root, 'bin'), log = join(root, 'versions.jsonl');
  mkdirSync(bin);
  const fixture = (path, version) => writeFileSync(path,
    '#!' + process.execPath + '\n' +
    'require("node:fs").appendFileSync(' + JSON.stringify(log) + ', JSON.stringify({bin:process.argv[1],sentinel:process.env.CF_DETECT_SENTINEL})+"\\n");\n' +
    'console.log(' + JSON.stringify(version) + ');\n', { mode: 0o700 });
  for (const name of ['claude', 'codex', 'gemini', 'dsh']) fixture(join(bin, name), 'fixture');
  const first = join(root, 'custom dsh'), second = join(root, 'second dsh');
  fixture(first, '0.2.1-rc.2'); fixture(second, '0.2.2-fixture');
  process.env.PATH = bin + ':' + dirname(process.execPath);
  process.env.HOME = root;
  delete process.env.CONTEXTFLOW_DSH_BIN;
  const config = { id: 'dsh', env: { CONTEXTFLOW_DSH_BIN: first, CF_DETECT_SENTINEL: 'only-dsh' } };
  const result = await detect(true, config);
  const selected = result.find(row => row.id === 'dsh');
  assert.equal(selected.path, first);
  assert.equal(selected.version, '0.2.1-rc.2');
  assert.equal(selected.source, 'explicit');
  assert.equal(selected.available, true);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.ok(calls.filter(call => call.bin !== first).every(call => call.sentinel === undefined));
  assert.equal(calls.find(call => call.bin === first).sentinel, 'only-dsh');
  assert.equal(await detect(false, config), result);
  const changed = await detect(false, { id: 'dsh', env: { ...config.env, CONTEXTFLOW_DSH_BIN: second } });
  assert.equal(changed.find(row => row.id === 'dsh').path, second);
  assert.equal(changed.find(row => row.id === 'dsh').version, '0.2.2-fixture');
  assert.equal(changed.find(row => row.id === 'dsh').connectionTestSupported, false);
  const count = readFileSync(log, 'utf8').trim().split('\n').length;
  assert.equal(await detect(false, config), result, '草稿与已保存配置切换不应互相挤掉探测缓存');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, count, '回到已探测配置不能再启动四个版本探测进程');
  const desktop = join(root, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  mkdirSync(dirname(desktop), {recursive:true});
  fixture(desktop,'0.2.1-rc.2');
  const desktopConfig={id:'dsh',env:{CONTEXTFLOW_DSH_BIN:desktop}};
  const desktopRows=await detect(true,desktopConfig);
  assert.equal(desktopRows.find(row=>row.id==='dsh').source,'desktop');
  assert.equal(desktopRows.find(row=>row.id==='dsh').connectionTestSupported,true);
  fixture(desktop,'0.2.2-unverified');
  assert.equal((await detect(true,desktopConfig)).find(row=>row.id==='dsh').connectionTestSupported,false);
  console.log('DSH 检测使用配置入口、配置变化失效缓存、其他 Agent 不接收所选 Agent 环境：通过');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
