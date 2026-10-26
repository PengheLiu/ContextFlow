import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const guide=read('docs/DESKTOP_LOCAL_VALIDATION.md');
assert.match(guide,/路径 A：公开产品验收/);
assert.match(guide,/路径 B：源码开发联调/);
assert.match(guide,/公开产品包只接受商店 ID，不能与固定开发 ID 配对/);
assert.match(guide,/aemncphfnlpbhlddifhohpgegejjejfm/);
assert.match(guide,/cgimipjfmopjcaedmgccaodjppdpkfjf/);
assert.match(guide,/preview.*额外接受开发 ID/);
assert.match(guide,/不要.*修改正式 allowlist/);
assert.match(guide,/公开商店暂未提供匹配入口.*不能完成/);
assert.match(guide,/artifact-subdir local-validation/);
assert.match(guide,/这里不要加 `--direct` 或 `--release`/);
assert.match(guide,/本地服务健康且无运行或排队任务/);
assert.match(guide,/故障保护副本/);
assert.match(guide,/WAL \/ SHM/);
assert.match(guide,/漏收必要 WAL.*不能追溯补回/);
const policy=read('store/privacy.html');
assert.match(policy,/故障保护副本.*不作为正常恢复点自动导入/);
assert.match(policy,/明文凭据不会因复制而自动加密/);
assert.match(policy,/请勿公开上传或分享/);
const desktop=read('docs/DESKTOP.md');
assert.match(desktop,/SHM.*不打包进正常恢复点/);
assert.match(desktop,/当前 core 与离线恢复共用 owner 锁/);
assert.match(desktop,/历史无锁 CLI 不能由此可靠识别/);

const currentOnboarding=read('docs/ONBOARDING_DESIGN.md').split('## 判断')[0];
assert.doesNotMatch(currentOnboarding,/必须明确写开发预览/);
assert.match(currentOnboarding,/不加“预览版”标签/);
const development=read('docs/DEVELOPMENT.md');
assert.doesNotMatch(development,/官网的匹配签名版本覆盖安装/);
assert.match(development,/当前独立分发包不冒充签名发行/);
assert.match(development,/不降低严格签名发行门禁/);
const deployment=read('store/DEPLOY.md');
assert.doesNotMatch(deployment,/`download\.html`[^\n]*商店 1\.0 配对/);
assert.match(deployment,/命令行服务兼容步骤放在完整指南的高级章节/);

for(const file of ['README.md','README.en.md']) {
  const source=read(file);
  assert.ok(source.includes('./docs/CAPABILITIES.md'),`${file}: current capability entry is not an archived release note`);
}
const capabilities=read('docs/CAPABILITIES.md');
assert.match(capabilities,/这里描述 ContextFlow 1\.1 的完整产品流程，不代表所有分发渠道已经提供这一版本/);
assert.match(capabilities,/导出和导入使用同一字节限制，不另设记录数或图片数门槛/);
assert.match(capabilities,/Markdown 不是可直接导回的 JSON 备份/);
assert.match(capabilities,/一个本地事务/);
assert.match(capabilities,/不恢复模型作业/);
for(const path of ['docs/GETTING_STARTED.md','docs/MARKDOWN.md','docs/CAPABILITIES.md'])
  assert.ok(existsSync(new URL(`../${path}`,import.meta.url)),`${path}: product documentation target exists`);

console.log('产品文档：direct/商店与preview/开发身份分开、独立分发与签名门禁、当前能力入口及备份边界一致');
