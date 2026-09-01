// 纯浏览器 Markdown 导出。
import assert from 'node:assert/strict';
import { renderEventMarkdown, renderArticleMarkdown, renderSourceMarkdown, safeMarkdownFilename } from '../src/core/markdown.js';

let pass = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const base = { urlKey: 'u', createdAt: 1, anchor: { start: 1 } };

console.log('浏览器 Markdown 导出\n');

t('翻译与解释保留原文和问题', () => {
  assert.equal(renderEventMarkdown({ ...base, action: 'translate', text: 'source', value: '译文' }), '> source\n译文');
  assert.match(renderEventMarkdown({ ...base, action: 'explain', text: 'source', value: '答案', extra: { question: '为什么' } }), /为什么.*> source.*答案/s);
});

t('deferred 明确导出占位，不伪装成答案', () => {
  assert.match(renderEventMarkdown({ ...base, action: 'translate', text: 'x', value: null, extra: { status: 'deferred' } }), /离线待处理/);
});

t('整篇按速览/翻译/解释/批注/总结组织', () => {
  const md = renderArticleMarkdown({ title: '文章', url: 'https://x', events: [
    { ...base, id: 'n', action: 'note', value: '我的总结' },
    { ...base, id: 't', action: 'translate', text: 'x', value: '译文' },
    { ...base, id: 's', action: 'summary', value: '速览' },
  ] });
  assert.ok(md.indexOf('## 速览') < md.indexOf('## 翻译'));
  assert.ok(md.indexOf('## 翻译') < md.indexOf('## 总结'));
  assert.match(md, /> 来源：<https:\/\/x\/>/);
});


t('来源链接只允许 http/https 并安全编码', () => {
  assert.equal(renderSourceMarkdown('https://例子.test/a b?q=(x)#一'),
    '> 来源：<https://xn--fsqu00a.test/a%20b?q=(x)#%E4%B8%80>');
  assert.equal(renderSourceMarkdown('javascript:alert(1)'), '');
  assert.equal(renderSourceMarkdown('data:text/html,x'), '');
  assert.equal(renderSourceMarkdown('not a url'), '');
});

t('删除记录不导出', () => {
  const md = renderArticleMarkdown({ title: 'T', url: '', events: [
    { ...base, id: 'd', action: 'note', value: '秘密', deletedAt: 2 },
  ] });
  assert.ok(!md.includes('秘密'));
});

t('文件名清理路径字符并限制长度', () => {
  const f = safeMarkdownFilename('../A:B?'.repeat(20), 'url:key');
  assert.ok(!/[\\/:?]/.test(f));
  assert.ok(f.endsWith('.md'));
  assert.ok([...f.slice(0, -3)].length <= 60);
});

console.log(`\n${pass} 项通过`);
