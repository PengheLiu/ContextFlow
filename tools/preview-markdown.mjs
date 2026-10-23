// Isolated real-component fixture: no extension credentials, model or note I/O.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/preview.js') {
      const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['test/markdown-preview.js'],
        bundle: true, write: false, format: 'iife', target: 'chrome111', define: { __CONTEXTFLOW_TOKEN__: '""' } });
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(result.outputFiles[0].contents);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'" });
      response.end(readFileSync(new URL('../test/markdown-preview.html', import.meta.url)));
    }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => console.log(`Markdown QA: http://127.0.0.1:${server.address().port} (PID ${process.pid})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
