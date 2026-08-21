// 扩展产物的结构与安全断言。
//
// 最要紧的一条：**token 只能出现在 sw.js，绝不能出现在 app.js**。
// app.js 是 content script、跑在页面上；token 一旦编译进去，扩展路线相对 userscript
// 的唯一实质优势（token 不进页面）就没了，而这件事从界面上完全看不出来 ——
// 只能靠测试守。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('扩展产物\n');

// 用一个可识别的假 token 构建：真 token 可能为空，那样"没泄漏"就成了假阳性。
const FAKE = 'cf-test-token-DO-NOT-LEAK-9f3a2b';
const HOME = mkdtempSync(join(tmpdir(), 'cf-extbuild-'));
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ token: FAKE }));

let built = true;
try {
  execFileSync('node', ['tools/build.mjs', '--ext'], {
    env: { ...process.env, HOME, CONTEXTFLOW_DIR: HOME },
    stdio: 'pipe',
  });
} catch (e) {
  built = false;
  console.log(`  FAIL 构建失败\n       ${String(e.stderr || e).slice(0, 300)}`);
  process.exitCode = 1;
}

const read = (f) => readFileSync(join('extension/dist', f), 'utf8');

if (built) {
  t('三个产物都在', () => {
    for (const f of ['manifest.json', 'app.js', 'sw.js']) {
      assert.ok(existsSync(join('extension/dist', f)), `缺 ${f}`);
    }
  });

  // ---- 核心安全属性 ----

  t('token 出现在 sw.js（否则扩展根本没法通过鉴权）', () =>
    assert.ok(read('sw.js').includes(FAKE), 'sw.js 里没有 token'));

  t('token **不出现**在 app.js（它跑在页面上）', () =>
    assert.ok(!read('app.js').includes(FAKE),
      'token 泄漏进了 content script —— 扩展相对 userscript 的唯一实质优势就没了'));

  t('app.js 里的 token 占位被编译成空串', () => {
    const s = read('app.js');
    assert.ok(!s.includes('__CONTEXTFLOW_TOKEN__'), '占位符没被替换');
  });

  // 真正的风险不是"bundle 里有拼 Bearer 的代码"（那是 userscript 路径的死代码，
  // token 已编译成空串），而是**入口忘了换传输层** —— 那样所有请求都会从页面直连
  // 本地服务、且不带 token，症状是"扩展装上了但一直连不上服务"。
  t('app.js 确实把传输层换成了走 service worker', () => {
    const s = read('app.js');
    assert.ok(s.includes('chrome.runtime.sendMessage'), '没有 sendMessage —— 传输层没换');
    assert.ok(s.includes('cf-fetch'), '没有 cf-fetch 消息类型');
  });

  // 不去 grep "有没有拼 Bearer 的代码" —— esbuild 折叠后形态多变，那种断言只会脆。
  // 真正要保证的是"直连路径带不出凭证"，而它已由上面两条（token 字面量不在 app.js、
  // 占位符已替换）覆盖：define 把 __CONTEXTFLOW_TOKEN__ 编成 ""，
  // 于是 Authorization 头永远拼不出有效值。传输层本身的行为在 test/transport.test.mjs 里测。

  // ---- manifest ----

  const mf = () => JSON.parse(read('manifest.json'));

  t('manifest_version 是 3', () => assert.equal(mf().manifest_version, 3));

  // 不写 world → 默认 ISOLATED。已实测那里的 CSS.highlights 能正常绘制，
  // 所以整套 UI 留在 ISOLATED，页面 JS 碰不到我们的东西，也伪造不了 chrome.runtime 消息。
  t('content script 用默认 world（ISOLATED），没有被改成 MAIN', () => {
    const cs = mf().content_scripts[0];
    assert.equal(cs.world, undefined,
      `world 被设成了 ${cs.world} —— MAIN 会让页面能读到我们的一切`);
    assert.deepEqual(cs.js, ['app.js']);
  });

  t('只申请必要权限：没有 tabs / <all_urls> / webRequest 这类大权限', () => {
    const m = mf();
    assert.deepEqual(m.permissions, ['storage']);
    assert.deepEqual(m.host_permissions, ['http://127.0.0.1:7317/*'],
      'host_permissions 应只含本地服务');
    assert.ok(!JSON.stringify(m).includes('<all_urls>'),
      'content_scripts 用 http/https 通配即可，不必申请 <all_urls>');
  });

  t('service worker 声明为 module（产物是 ESM）', () =>
    assert.equal(mf().background.type, 'module'));

  // 不写 key 的话扩展 id 由目录路径派生 —— 移动目录或换机器 id 就变，
  // 服务端 allowedOrigins 里的白名单立刻失效
  t('manifest 带 key，扩展 id 才稳定', () => {
    const k = mf().key;
    assert.ok(k && k.length > 300, 'key 缺失或不像公钥');
  });

  t('manifest 里的 key 能推出与构建输出一致的 id', () => {
    const der = Buffer.from(mf().key, 'base64');
    const h = createHash('sha256').update(der).digest('hex').slice(0, 32);
    const id = [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.match(id, /^[a-p]{32}$/, `推出的 id 形状不对：${id}`);
  });

  t('content script 匹配 http/https 而不是 file://（file 需单独授权，且没意义）', () => {
    assert.deepEqual(mf().content_scripts[0].matches, ['http://*/*', 'https://*/*']);
  });

  // ---- 图标 ----
  //
  // manifest 引用了却没拷进 dist 的话，Chrome 只会显示默认的拼图占位图 ——
  // 不报错、不提示，很容易一直没人注意。

  t('manifest 引用的每个图标都真的在 dist 里', () => {
    const m = mf();
    const refs = [...Object.values(m.action?.default_icon || {}), ...Object.values(m.icons || {})];
    assert.ok(refs.length >= 4, `只引用了 ${refs.length} 个图标`);
    for (const f of new Set(refs)) {
      assert.ok(existsSync(join('extension/dist', f)), `manifest 引用了 ${f} 但没拷进 dist`);
    }
  });

  // Chrome 按 DPI 与位置挑尺寸；只给一个大图会被降采样糊掉
  t('工具栏图标给了多个尺寸', () => {
    const sizes = Object.keys(mf().action?.default_icon || {}).map(Number).sort((a, b) => a - b);
    assert.deepEqual(sizes, [16, 32, 48, 128]);
  });

  t('每个图标的实际像素尺寸与声明的键一致（不一致会被缩放糊掉）', () => {
    for (const [key, f] of Object.entries(mf().action.default_icon)) {
      const b = readFileSync(join('extension/dist', f));
      // PNG 的 IHDR 紧跟 8 字节签名 + 4 长度 + 4 类型
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
      assert.equal(w, Number(key), `${f} 宽 ${w}，声明 ${key}`);
      assert.equal(h, Number(key), `${f} 高 ${h}，声明 ${key}`);
    }
  });

  // 这才是"图标看起来太小"的根因：icon-512 有圆角底和大留白，墨迹只占 31% 高度，
  // 且底色接近白、在工具栏上等于透明。工具栏那套是紧贴边界的构图。
  t('工具栏图标不是 icon-512 的副本（构图不同，不能复用）', () => {
    const a = readFileSync(join('extension/dist', 'toolbar-128.png'));
    const b = readFileSync(join('extension/dist', 'icon-512.png'));
    assert.ok(!a.equals(b), '工具栏图标直接用了 icon-512');
    assert.ok(!Object.values(mf().action.default_icon).includes('icon-512.png'),
      'action.default_icon 里出现了 icon-512.png —— 那个构图在工具栏上会显得又小又淡');
  });
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} 项通过`);
