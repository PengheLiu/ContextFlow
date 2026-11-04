import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detect, currentExecutionIdentity } from '../server/agent.mjs';
import { ConnectionChecks } from '../server/connection-checks.mjs';
import { testAgentConnection } from '../server/agent-test.mjs';

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
  const app = join(root, 'Applications/DeepSeek Harness.app');
  const archive = join(app, 'Contents/Resources/app.asar');
  const host = join(app, 'Contents/MacOS/DeepSeek Harness');
  const versionFile = join(app, 'Contents/Resources/fixture-version');
  mkdirSync(dirname(host), {recursive:true});
  writeFileSync(versionFile, '0.2.1-rc.2');
  writeFileSync(archive, 'fixture runtime rc.2');
  writeFileSync(host, 'fixture desktop executable', {mode:0o700});
  writeFileSync(desktop, '#!' + process.execPath + '\n'
    + 'require("node:fs").appendFileSync(' + JSON.stringify(log) + ', JSON.stringify({bin:process.argv[1]})+"\\n");\n'
    + 'console.log(require("node:fs").readFileSync(' + JSON.stringify(versionFile) + ',"utf8"));\n', {mode:0o700});
  const wrapper = readFileSync(desktop, 'utf8');
  const desktopConfig={id:'dsh',env:{CONTEXTFLOW_DSH_BIN:desktop}};
  const desktopRows=await detect(true,desktopConfig);
  const desktopRow = desktopRows.find(row=>row.id==='dsh');
  assert.equal(desktopRow.source,'desktop');
  assert.equal(desktopRow.connectionTestSupported,true);
  const checks = new ConnectionChecks(join(root, 'checks'), 'isolated-fixture-secret');
  const checkConfig = {translate:{provider:'openai'},agent:{id:'dsh',profile:'full',env:{}}};
  checks.finish(checks.begin(checks.agentKey({...desktopRow,profile:'full',env:{}})),true);
  assert.equal(checks.view(checkConfig,desktopRows).agents.dsh.ok,true);
  writeFileSync(versionFile, '0.2.1-rc.5');
  writeFileSync(archive, 'fixture runtime upgraded to rc.5');
  const updated=await detect(false,desktopConfig);
  assert.equal(updated.find(row=>row.id==='dsh').version,'0.2.1-rc.5');
  assert.equal(updated.find(row=>row.id==='dsh').connectionTestSupported,true,'rc.5 支持连接测试，不能因旧版本白名单禁用按钮');
  assert.notEqual(updated.find(row=>row.id==='dsh').identity,desktopRow.identity);
  assert.equal(checks.view(checkConfig,updated).agents.dsh,undefined,'升级后旧成功测试不可继续显示为可用');
  assert.equal(readFileSync(desktop,'utf8'),wrapper,'只升级桌面运行时，不改 CLI 包装器');
  writeFileSync(versionFile, '0.2.2-unverified');
  writeFileSync(archive, 'fixture future desktop runtime with compatible probe');
  const futureRows = await detect(false,desktopConfig), future = futureRows.find(row=>row.id==='dsh');
  assert.equal(future.version,'0.2.2-unverified');
  assert.equal(future.connectionTestSupported,true,'未知版本仍允许尝试隔离连接测试，能力兼容性由测试实际验证');
  assert.equal(checks.view(checkConfig,futureRows).agents.dsh,undefined);
  const beforeHostUpgrade = future.identity;
  writeFileSync(host,'fixture upgraded desktop executable, unchanged CLI');
  const hostRows = await detect(false,desktopConfig), hostRow = hostRows.find(row=>row.id==='dsh');
  assert.notEqual(hostRow.identity,beforeHostUpgrade,'主程序更新也应使缓存失效');
  assert.equal(hostRow.version,future.version);
  assert.equal(await detect(false,desktopConfig),hostRows,'未变化的桌面仍复用检测缓存');
  assert.equal(currentExecutionIdentity({id:'dsh',path:desktop}),hostRow.identity);
  await assert.rejects(testAgentConnection({id:'dsh',label:'DeepSeek Harness',path:desktop,
    version:hostRow.version,identity:hostRow.identity,env:{}}, {run:async()=>{
      writeFileSync(archive,'fixture runtime replaced during a successful model-only check');
      return {answer:'OK'};
    }}),error=>error.code==='AGENT_CONFIGURATION_CHANGED','测试途中升级不能将旧进程结果记为新版验证成功');
  assert.equal(readFileSync(desktop,'utf8'),wrapper);
  console.log('DSH 检测、桌面原位升级清除缓存与旧测试、未知版本允许重测、测试中升级拒绝旧结果：通过');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
