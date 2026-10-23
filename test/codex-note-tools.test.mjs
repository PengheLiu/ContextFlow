import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexNoteTools } from '../server/codex-note-tools.mjs';

const dir = await mkdtemp(join(tmpdir(), 'contextflow-note-tools-'));
const root = join(dir, 'notes');
await mkdir(root);
let pass = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (error) { console.error(`  FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

try {
  const tools = createCodexNoteTools(root);
  await mkdir(join(root, 'research'));
  await writeFile(join(root, 'research', 'paper.md'), '第一行\r\nMemory and RECALL\r\n第三行\r\n第四行');
  await writeFile(join(root, 'code.js'), 'RECALL must not be read');
  await mkdir(join(root, '.private'));
  await writeFile(join(root, '.private', 'secret.md'), 'RECALL hidden');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dependency.md'), 'RECALL dependency');
  await writeFile(join(dir, 'outside.md'), 'RECALL outside-private-content');

  await test('未配置目录不注册工具；不存在目录只在调用时报告', async () => {
    assert.deepEqual(createCodexNoteTools('').tools, []);
    assert.deepEqual(createCodexNoteTools(null).tools, []);
    const missing = createCodexNoteTools(join(dir, 'missing'));
    assert.equal(missing.tools.length, 2);
    await assert.rejects(missing.call('contextflow_read_note', { path: 'a.md' }), error => error.code === 'NOTE_ROOT_MISSING');
    await assert.rejects(createCodexNoteTools('').call('contextflow_search_notes', { query: 'x' }), error => error.code === 'NOTE_TOOL_UNKNOWN');
  });

  await test('按行分页，返回相对来源与可继续读取的位置', async () => {
    const page = await tools.call('contextflow_read_note', { path: 'research/paper.md', startLine: 2, maxLines: 2 });
    assert.equal(page.path, 'research/paper.md');
    assert.deepEqual(page.lines, [{ line: 2, text: 'Memory and RECALL' }, { line: 3, text: '第三行' }]);
    assert.equal(page.nextLine, 4); assert.equal(page.totalLines, 4); assert.equal(page.truncated, true);
    const last = await tools.call('contextflow_read_note', { path: page.path, startLine: page.nextLine });
    assert.deepEqual(last.lines, [{ line: 4, text: '第四行' }]);
    assert.equal(last.nextLine, null); assert.equal(last.truncated, false);
  });

  await test('拒绝绝对路径、目录穿越、隐藏内容、依赖和非笔记类型', async () => {
    for (const path of ['../outside.md', 'research/../../outside.md', join(dir, 'outside.md'), 'C:\\notes\\x.md',
      'research\\paper.md', '.private/secret.md', 'node_modules/dependency.md', 'code.js', 'research/./paper.md']) {
      await assert.rejects(tools.call('contextflow_read_note', { path }), error => ['NOTE_PATH', 'NOTE_TYPE'].includes(error.code), path);
    }
    await assert.rejects(tools.call('contextflow_read_note', { path: 'research/paper.md', maxLines: 201 }), error => error.code === 'NOTE_INPUT');
    await assert.rejects(tools.call('contextflow_read_note', { path: 'research/paper.md', startLine: 0 }), error => error.code === 'NOTE_INPUT');
    await assert.rejects(tools.call('contextflow_search_notes', { query: 'x', command: 'cat' }), error => error.code === 'NOTE_INPUT');
  });

  await test('符号链接无法越界，搜索不遍历链接目录或泄露外部内容', async () => {
    await symlink(join(dir, 'outside.md'), join(root, 'escape.md'));
    await symlink(dir, join(root, 'outside-directory'));
    await symlink(join(root, '.private', 'secret.md'), join(root, 'hidden-alias.md'));
    await assert.rejects(tools.call('contextflow_read_note', { path: 'escape.md' }), error => error.code === 'NOTE_PATH');
    await assert.rejects(tools.call('contextflow_read_note', { path: 'outside-directory/outside.md' }), error => error.code === 'NOTE_PATH');
    await assert.rejects(tools.call('contextflow_read_note', { path: 'hidden-alias.md' }), error => error.code === 'NOTE_PATH');
    const result = await tools.call('contextflow_search_notes', { query: 'recall' });
    assert.deepEqual(result.matches.map(item => [item.path, item.line]), [['research/paper.md', 2]]);
    assert.equal(JSON.stringify(result).includes('outside-private-content'), false);
    assert.equal(JSON.stringify(result).includes(root), false);
  });

  await test('每次调用重新核实路径，替换为越界链接后不能继续读取', async () => {
    await writeFile(join(root, 'changing.md'), 'initial');
    assert.equal((await tools.call('contextflow_read_note', { path: 'changing.md' })).lines[0].text, 'initial');
    await unlink(join(root, 'changing.md'));
    await symlink(join(dir, 'outside.md'), join(root, 'changing.md'));
    await assert.rejects(tools.call('contextflow_read_note', { path: 'changing.md' }), error => error.code === 'NOTE_PATH');
  });

  await test('字面子串检索，不将正则或shell字符解释为指令', async () => {
    await writeFile(join(root, 'literal.txt'), 'prefix .* $(echo injected) suffix\nother');
    const result = await tools.call('contextflow_search_notes', { query: '.* $(echo injected)' });
    assert.equal(result.matches.length, 1); assert.equal(result.matches[0].path, 'literal.txt');
    assert.equal(result.matches[0].line, 1);
    await assert.rejects(tools.call('contextflow_search_notes', { query: ' ' }), error => error.code === 'NOTE_INPUT');
    await assert.rejects(tools.call('contextflow_search_notes', { query: 'x'.repeat(201) }), error => error.code === 'NOTE_INPUT');
  });

  await test('结果、单页输出、单文件读取都有上限，二进制不返回', async () => {
    await writeFile(join(root, 'many.md'), Array.from({ length: 40 }, (_, i) => `needle row ${i}`).join('\n'));
    const matches = await tools.call('contextflow_search_notes', { query: 'needle', limit: 3 });
    assert.equal(matches.matches.length, 3); assert.equal(matches.truncated, true);
    await writeFile(join(root, 'long.md'), Array.from({ length: 100 }, () => 'L'.repeat(3000)).join('\n'));
    const page = await tools.call('contextflow_read_note', { path: 'long.md', maxLines: 200 });
    assert.ok(page.lines.reduce((sum, item) => sum + item.text.length, 0) <= 24000);
    assert.ok(page.lines.every(item => item.text.length <= 2000)); assert.equal(page.truncated, true);
    assert.ok(page.nextLine > 1);
    await writeFile(join(root, 'large.md'), 'S'.repeat(1024 * 1024 + 1));
    await assert.rejects(tools.call('contextflow_read_note', { path: 'large.md' }), error => error.code === 'NOTE_TOO_LARGE');
    await writeFile(join(root, 'binary.md'), Buffer.from([0, 255, 1, 2]));
    await assert.rejects(tools.call('contextflow_read_note', { path: 'binary.md' }), error => error.code === 'NOTE_TYPE');
  });

  await test('检索限制扫描的文件数并明确报告截断', async () => {
    const largeRoot = join(dir, 'many-notes');
    await mkdir(largeRoot);
    await Promise.all(Array.from({ length: 305 }, (_, i) => writeFile(join(largeRoot, `${i}.md`), 'nothing')));
    const result = await createCodexNoteTools(largeRoot).call('contextflow_search_notes', { query: 'absent' });
    assert.equal(result.matches.length, 0); assert.equal(result.searchedFiles, 300); assert.equal(result.truncated, true);
  });

  await test('根目录链接在首次授权后改指向时拒绝继续使用', async () => {
    const link = join(dir, 'selected-notes');
    await symlink(root, link);
    const linked = createCodexNoteTools(link);
    await linked.call('contextflow_read_note', { path: 'research/paper.md' });
    await unlink(link); await symlink(dir, link);
    await assert.rejects(linked.call('contextflow_read_note', { path: 'outside.md' }), error => error.code === 'NOTE_ROOT_CHANGED');
  });
} finally { await rm(dir, { recursive: true, force: true }); }

console.log(`\n${pass} 项通过`);
