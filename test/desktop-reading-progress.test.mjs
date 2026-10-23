import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const isolatedEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:TOKEN|API.?KEY|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|AUTH)/i.test(key)
  && !/^(?:CONTEXTFLOW_|CODEX_|DSH_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(key)
  && !['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key)));

test('real isolated desktop core shares browser answer/sync progress through coherent frames and IPC', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'contextflow-reading-progress-'));
  const data = join(root, 'data'), notesA = join(root, 'notes-a'), notesB = join(root, 'notes-b'); mkdirSync(data);
  let service, modelRequests = 0, changedEvents = 0;
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); return response.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'isolated-product-model');
    assert.equal(request.headers.authorization, 'Bearer only-local-fixture-key');
    modelRequests++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'This answer came from the isolated local HTTP fixture.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8 } }));
  });
  try {
    const providerPort = await listen(provider);
    const reservation = createServer(); const corePort = await listen(reservation); await new Promise(resolveClose => reservation.close(resolveClose));
    writeFileSync(join(data, 'config.json'), JSON.stringify({
      port: corePort, token: 'isolated-core-token', requireToken: true,
      translate: { provider: 'openai', model: 'isolated-product-model', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'only-local-fixture-key', chunkChars: 0 },
      explain: { backend: 'llm' }, agent: { id: '', executable: '', notesDir: '', profile: 'safe' },
      sync: { backend: 'markdown' }, markdown: { dir: notesA, folder: '/reading' },
    }));
    service = new ServiceManager({ paths: { data, logs: join(root, 'logs') }, runtime: process.execPath,
      core: fileURLToPath(new URL('..', import.meta.url)), secretKey: randomBytes(32).toString('base64'), terminateTree, environment: isolatedEnvironment() });
    service.on('changed', () => { changedEvents++; });
    await service.start(); assert.equal(service.state, 'running', service.message);
    const raw = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${corePort}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${service.token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const managed = async (path, body) => {
      const response = await service.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }, { timeoutMs: 5000 });
      assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
    };
    const frame = () => managed('/desktop/state');
    const expectChanged = async (before, label) => {
      const deadline = Date.now() + 1500;
      while (changedEvents <= before && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      assert.ok(changedEvents > before, `${label} must reach ServiceManager through IPC without waiting for UI polling`);
    };

    const initial = await frame();
    assert.equal(initial.health.desktopManaged, true); assert.equal(initial.configuration.agent.id, '');
    assert.equal(initial.configuration.connectionChecks.model, null);
    assert.equal(initial.health.readingStatus.ai.verified, false); assert.equal(initial.health.syncStatus.verified, false);

    const explanation = { text: 'An isolated source passage.', question: 'Explain this fixture.', urlKey: 'isolated-product-answer', offset: 0, fresh: true };
    let before = changedEvents;
    const answer = await raw('/explain', explanation); await expectChanged(before, 'A new browser answer');
    assert.equal(answer.cached, false); assert.equal(answer.via, 'llm'); assert.equal(modelRequests, 1);
    const answered = await frame();
    assert.equal(answered.configuration.connectionChecks.model, null, 'actual use does not invent a connection-test receipt');
    assert.equal(answered.health.readingStatus.ai.verified, true);
    assert.ok(answered.health.readingStatus.ai.lastAnswerAt > 0);

    // Cached content must not validate a newly changed connection identity.
    await managed('/config', { translate: { apiKey: 'changed-local-fixture-key' } });
    assert.equal((await frame()).health.readingStatus.ai.verified, false);
    const cached = await raw('/explain', { ...explanation, fresh: false });
    assert.equal(cached.cached, true); assert.equal(modelRequests, 1);
    assert.equal((await frame()).health.readingStatus.ai.verified, false, 'a cache hit is not proof of a new live connection');
    await managed('/config', { translate: { apiKey: 'only-local-fixture-key' } });

    const note = { id: 'isolated-note-id', action: 'comment', urlKey: 'isolated-note-article', url: 'https://fixture.invalid/reading',
      title: 'Isolated desktop progress fixture', text: 'A temporary source quote', value: 'A temporary note written only under the test directory.', createdAt: Date.now() };
    const saved = await raw('/events', [note]); assert.equal(saved.saved, 1);
    before = changedEvents;
    const written = await managed('/sync', { urlKey: note.urlKey }); await expectChanged(before, 'A real user-triggered sync');
    assert.equal(written.backend, 'markdown'); assert.equal(written.articles, 1); assert.ok(written.files.length > 0);
    for (const file of written.files) {
      const actual = isAbsolute(file) ? file : resolve(notesA, 'reading', file);
      const within = relative(notesA, actual);
      assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'only the temporary notes destination may be written');
      assert.match(readFileSync(actual, 'utf8'), /A temporary note written only under the test directory/);
    }
    const synced = await frame();
    assert.equal(synced.health.syncStatus.verified, true);
    assert.equal(synced.health.readingStatus.sync.completed, true); assert.equal(synced.health.readingStatus.sync.changed, true);

    before = changedEvents;
    const unchanged = await managed('/sync', { urlKey: note.urlKey }); await expectChanged(before, 'A completed no-change sync');
    assert.deepEqual(unchanged.files, []);
    const noChange = await frame();
    assert.equal(noChange.health.readingStatus.sync.completed, true); assert.equal(noChange.health.readingStatus.sync.changed, false);
    assert.equal(noChange.health.syncStatus.verified, true, 'a no-change sync preserves the earlier actual-write receipt');

    before = changedEvents;
    await managed('/config', { translate: { model: 'unanswered-product-model' }, markdown: { dir: notesB } });
    await expectChanged(before, 'A browser configuration change');
    const changedDestination = await frame();
    assert.equal(changedDestination.configuration.markdown.dir, notesB);
    assert.equal(changedDestination.health.syncStatus.verified, false, 'the old destination receipt cannot validate a new location');
    assert.equal(changedDestination.health.readingStatus.sync.completed, false);
    assert.equal(changedDestination.health.readingStatus.ai.verified, false);

    const checkCoherent = current => {
      const oldModel = current.configuration.translate.model === 'isolated-product-model';
      const oldDestination = current.configuration.markdown.dir === notesA;
      assert.equal(oldModel, oldDestination, 'the two fields were patched in one configuration transaction');
      assert.equal(current.health.readingStatus.ai.verified, oldModel, 'AI receipt and public configuration must belong to one frame');
      assert.equal(current.health.syncStatus.verified, oldDestination, 'write receipt and public destination must belong to one frame');
      assert.equal(current.health.readingStatus.sync.completed, oldDestination);
      assert.equal(current.health.hasApiKey, current.configuration.translate.apiKeySet);
    };
    // Exercise request interleavings rather than validating only quiet frames.
    for (let iteration = 0; iteration < 12; iteration++) {
      const original = iteration % 2 === 0;
      const operations = await Promise.all([
        managed('/config', { translate: { model: original ? 'isolated-product-model' : 'unanswered-product-model' }, markdown: { dir: original ? notesA : notesB } }),
        frame(), frame(),
      ]);
      checkCoherent(operations[1]); checkCoherent(operations[2]); checkCoherent(await frame());
    }
    assert.equal(modelRequests, 1, 'configuration/status/sync checks must not invoke another model or any Agent');
    const progressFile = readFileSync(join(data, 'reading-status.json'), 'utf8');
    assert.ok(!progressFile.includes(note.value) && !progressFile.includes(note.url) && !progressFile.includes('fixture-key'), 'progress receipts contain no article, note or credential content');
  } finally {
    if (service) await service.stop().catch(() => {});
    provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});
