import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { companionCommands } from '../src/ext/setup-commands.js';
import { CATEGORIES } from '../src/core/markdown.js';
const read=path=>readFileSync(path,'utf8');
const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);
const documents=['README.md','README.en.md','docs/GETTING_STARTED.md','docs/RELEASE_1_0.md','store/COMPANION.md','store/LISTING.zh-CN.md'];
for(const file of documents) {
  const source=read(file);
  // Both Markdown and embedded HTML image/link paths must remain usable in GitHub.
  const links=[...source.matchAll(/\]\(([^)\s]+)\)/g)].map(m=>m[1]);
  links.push(...[...source.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]));
  for(const href of links) {
    if(/^[a-z][a-z\d+.-]*:|^#/i.test(href))continue;
    assert.ok(existsSync(resolve(dirname(file),href.split('#')[0])),`${file} 本地链接失效：${href}`);
  }
  assert.doesNotMatch(source,/\/Users\/|cf-test-token-|__CONTEXTFLOW_TOKEN__/);
}
const id='aemncphfnlpbhlddifhohpgegejjejfm';
for(const file of ['docs/GETTING_STARTED.md','store/COMPANION.md']) {
  assert.ok(read(file).includes(companionCommands(id).setup),`${file} 必须提供与实际扩展一致的完整安装命令`);
  assert.ok(read(file).includes('22.13'));
}
for(const file of ['README.md','README.en.md']) {
  assert.ok(read(file).includes(`v${pkg.version}`));
  assert.ok(read(file).includes('assets/readme/reading-library.png'));
  assert.ok(read(file).includes(`https://chromewebstore.google.com/detail/contextflow/${id}`));
  assert.ok(read(file).includes('32 MB'));
}
const website=new JSDOM(read('store/index.html')).window.document;
const demo=website.querySelector('.markdown-example code').textContent;
let previous=-1;
for(const category of CATEGORIES) {const at=demo.indexOf(`## ${category.label}`);assert.ok(at>previous,`官网 Markdown 分类顺序与导出不一致：${category.label}`);previous=at;}
assert.match(website.body.textContent,/翻译需配置 LLM/);
assert.match(website.body.textContent,/32 MB/);
assert.match(read('src/skill/settings.js'),/翻译始终使用上方的 LLM/);
for(const path of ['assets/readme/inline-annotation.png','assets/readme/reading-library.png']) {
  const png=readFileSync(path);assert.ok(png.readUInt32BE(16)>=1280);assert.ok(png.readUInt32BE(20)>=800);
}
website.defaultView?.close();
const extractReviewCopy=source=>{
  // Git checkouts may use CRLF; count the actual copy, not Windows line endings.
  const sections=source.replace(/\r\n?/g,'\n').split('## 可粘贴说明\n\n');
  assert.equal(sections.length,2,'审核指引必须有且仅有一个「可粘贴说明」段落');
  const review=sections[1].split('\n\n##')[0];
  assert.ok(review.trim(),'审核指引不可为空');
  assert.ok(review.length<=500,'审核指引必须能放入商店说明字段');
  return review;
};
const reviewSource=read('store/REVIEW_INSTRUCTIONS.zh-CN.md');
const review=extractReviewCopy(reviewSource);
for(const newline of ['\n','\r\n']) {
  assert.equal(extractReviewCopy(reviewSource.replace(/\r\n?/g,'\n').replace(/\n/g,newline)),review,'LF / CRLF 必须提取相同审核指引');
  const fixture=`# 审核\n\n## 可粘贴说明\n\n${'测'.repeat(500)}\n\n## 核对\n\n不得复制此段`;
  assert.equal(extractReviewCopy(fixture.replace(/\n/g,newline)),'测'.repeat(500));
  assert.throws(()=>extractReviewCopy(fixture.replace('测'.repeat(500),'测'.repeat(501)).replace(/\n/g,newline)),/审核指引必须能放入商店说明字段/);
  assert.throws(()=>extractReviewCopy('## 其他\n\n内容'.replace(/\n/g,newline)),/必须有且仅有一个/);
  assert.throws(()=>extractReviewCopy((fixture+'\n\n## 可粘贴说明\n\n重复').replace(/\n/g,newline)),/必须有且仅有一个/);
  assert.throws(()=>extractReviewCopy('## 可粘贴说明\n\n\n\n## 核对'.replace(/\n/g,newline)),/审核指引不可为空/);
}
console.log('跨入口一致性：版本、商店 ID、真实安装命令、GitHub 本地链接、阅读库、翻译前提、备份边界、Markdown 顺序与截图检查通过');
