import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertExtensionText } from '../tools/extension-text.mjs';

const extractListingSummary=source=>{
  const sections=source.replace(/\r\n?/g,'\n').split('## 简介\n\n');
  assert.equal(sections.length,2,'商店资料必须有且仅有一个「简介」段落');
  const summary=sections[1].split('\n')[0];
  assert.ok(summary.trim(),'商店简介不可为空');
  return summary;
};

const directory = mkdtempSync(join(tmpdir(), 'contextflow-store-test-'));
const output = join(directory, 'extension');
const sentinel = 'cf-test-token-publisher-secret-must-never-ship';
try {
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ token: sentinel }));
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    env: { ...process.env, CONTEXTFLOW_DIR: directory, CONTEXTFLOW_EXT_DIR: output }, stdio: 'pipe',
  });
  const files = readdirSync(output);
  for (const file of files) assert.ok(!readFileSync(join(output, file)).includes(sentinel), `${file} 泄露发布者 token`);
  for (const file of files.filter(name => /\.(?:js|json|html|css)$/.test(name))) {
    assertExtensionText(readFileSync(join(output, file)), file);
  }
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  const { JSDOM }=await import('jsdom');
  const policy=new JSDOM(readFileSync(join(output,'privacy.html'),'utf8')).window.document;
  const sourcePolicy=new JSDOM(readFileSync('store/privacy.html','utf8')).window.document;
  assert.equal(policy.body.textContent,sourcePolicy.body.textContent,'扩展与官网隐私正文必须完全一致');
  assert.ok(files.includes(policy.querySelector('link[rel=icon]').getAttribute('href')),'扩展隐私图标必须随包提供');
  const listing=readFileSync('store/LISTING.zh-CN.md','utf8');
  const release=JSON.parse(readFileSync('product/release.json','utf8'));
  const listingSummary=extractListingSummary(listing);
  assert.equal(listingSummary,manifest.description,'商店简介与实际 manifest 一致');
  for(const newline of ['\n','\r\n']) {
    assert.equal(extractListingSummary(listing.replace(/\r\n?/g,'\n').replace(/\n/g,newline)),manifest.description,'LF / CRLF 商店简介均须与实际 manifest 一致');
    assert.throws(()=>extractListingSummary('## 其他\n\n内容'.replace(/\n/g,newline)),/必须有且仅有一个/);
    assert.throws(()=>extractListingSummary('## 简介\n\n重复\n\n## 简介\n\n重复'.replace(/\n/g,newline)),/必须有且仅有一个/);
    assert.throws(()=>extractListingSummary('## 简介\n\n\n\n## 其他'.replace(/\n/g,newline)),/商店简介不可为空/);
    assert.throws(()=>assert.equal(extractListingSummary('## 简介\n\n错误的简介\n\n## 其他'.replace(/\n/g,newline)),manifest.description),assert.AssertionError,'换行兼容不可掩盖简介与 manifest 的真实差异');
  }
  assert.equal(manifest.version,release.candidateVersion,'打包候选版本必须与中央发布状态一致');
  assert.ok(release.publishedExtension.version,'中央发布状态保留真实公开版本，不靠营销正文判定商店审核结果');
  assert.ok(listing.includes(`当前源码版本 **${release.candidateVersion}**`),'商店源稿必须区分当前源码与历史实际送审内容');
  assert.match(policy.body.textContent,/设置与帮助.*浏览器授权/,'隐私撤销指引必须可在真实桌面界面找到');
  policy.defaultView?.close();sourcePolicy.defaultView?.close();
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions,['storage','nativeMessaging'],'本轮权限与公开资料保持一致，不添加历史/标签/剪贴板权限');
  assert.equal(manifest.key, undefined);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:7317/*']);
  assert.equal(manifest.options_ui.page, 'options.html');
  for (const file of ['options.html', 'options.js', 'options.css', 'privacy.html']) assert.ok(files.includes(file));
  assert.ok(!readFileSync(join(output, 'options.js'), 'utf8').includes('__CONTEXTFLOW_TOKEN__'));
  const icon = readFileSync(join(output, manifest.icons[128]));
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
  const app = readFileSync(join(output, 'app.js'), 'utf8');
  assert.ok(app.includes('Third-party Markdown and math libraries'));
  assert.ok(app.includes('Khan Academy and other contributors'));
  assert.ok(app.indexOf('setBrowserStorage({') < app.indexOf('migrateLegacyKeys()'));
  assert.ok(app.includes('cf-offline'));
  assert.ok(app.includes('createContentStartup') && app.includes('startup-error'),'content startup failure has a bounded recovery path');
  const worker = readFileSync(join(output, 'sw.js'), 'utf8');
  assert.ok(worker.includes('TRUSTED_CONTEXTS'));
  assert.ok(worker.includes('PAIRING_REQUIRED'));
  console.log('商店构建：凭证隔离、manifest、设置页、图标及私有存储初始化顺序通过');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
