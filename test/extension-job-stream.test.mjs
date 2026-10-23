import assert from 'node:assert/strict';
const extensionId = 'a'.repeat(32), token = 'private-stream-pairing-token';
let listener, requests = [], paired = true, responseFactory;
globalThis.chrome = {
  runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
    onConnect: { addListener: fn => { listener = fn; } },
    onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  action: { onClicked: { addListener() {} } },
  storage: { local: { setAccessLevel: async () => {}, get: async () => ({ connection: paired ? { token } : { disconnected: true } }) } },
};
globalThis.fetch = async (url, options) => { requests.push({ url, options }); return responseFactory(); };
await import('../extension/sw.js');
const makePort = (sender = { id: extensionId, url: 'https://example.org/article', tab: { id: 1 }, frameId: 0 }) => {
  let receive, disconnected;
  return { name: 'cf-job-stream', sender, sent: [], closed: false,
    onMessage: { addListener: fn => { receive = fn; } },
    onDisconnect: { addListener: fn => { disconnected = fn; } },
    postMessage(value) { this.sent.push(value); },
    disconnect() { if (!this.closed) { this.closed = true; disconnected?.(); } },
    send(value) { return receive?.(value); },
  };
};
const frames = jobs => new Response(jobs.map(job => `data: ${JSON.stringify({ job })}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

const blocked = makePort({ id: 'b'.repeat(32), url: 'https://untrusted.test', tab: { id: 1 }, frameId: 0 });
listener(blocked); assert.equal(blocked.closed, true); assert.equal(requests.length, 0);
const frame = makePort({ id: extensionId, url: 'https://example.org', tab: { id: 1 }, frameId: 1 });
listener(frame); assert.equal(frame.closed, true);
const traversal = makePort(); listener(traversal); await traversal.send({ id: '../config' }); assert.equal(requests.length, 0);
paired = false;
const unpaired = makePort(); listener(unpaired); await unpaired.send({ id: 'j1' }); assert.equal(requests.length, 0);
paired = true;

responseFactory = () => frames([{ id: 'j1', status: 'running', partialAnswer: '<b>partial</b>' }, { id: 'j1', status: 'done', result: { answer: 'complete' } }]);
const port = makePort(); listener(port); await port.send({ id: 'j1', token: 'page-supplied-token' });
assert.equal(requests[0].url, 'http://127.0.0.1:7317/jobs/j1/stream');
assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
assert.equal(requests[0].options.headers['X-ContextFlow-Extension'], extensionId);
assert.equal(requests[0].options.redirect, 'error');
assert.equal(requests[0].url.includes(token), false);
assert.equal(JSON.stringify(port.sent).includes(token), false);
assert.deepEqual(port.sent.filter(value => value.type === 'job').map(value => value.job.status), ['running', 'done']);
assert.equal(port.sent.at(-1).type, 'end'); assert.equal(port.closed, true);
await port.send({ id: 'j2' }); assert.equal(requests.length, 1, 'a port subscribes only once');

let bodyCanceled = false;
responseFactory = () => new Response(new ReadableStream({ cancel() { bodyCanceled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
const detached = makePort(); listener(detached); const running = detached.send({ id: 'j2' });
while (!detached.sent.some(value => value.type === 'ready')) await new Promise(resolve => setTimeout(resolve, 1));
detached.disconnect(); await running;
assert.equal(bodyCanceled, true); assert.equal(requests.at(-1).options.signal.aborted, true);
assert.equal(requests.some(request => request.options.method === 'DELETE'), false, 'closing a view must not cancel the task');
console.log('扩展事件流：来源/路径校验、凭证仅在可信SW、不回显token、单次订阅、断开释放连接而不取消任务通过');
