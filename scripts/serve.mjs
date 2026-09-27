// Tiny static server for local testing: serves app/ with no caching and no SPA fallback.
//
//   node scripts/serve.mjs [--port 8787] [--host 127.0.0.1]
//   (--host 0.0.0.0 to reach it from a phone on the same Wi-Fi)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', 8787));
const HOST = arg('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function resolveFile(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = resolve(ROOT, '.' + p);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return null; // path traversal
  try {
    const s = await stat(file);
    if (s.isFile()) return { file, size: s.size };
    if (s.isDirectory()) {
      const idx = join(file, 'index.html');
      const si = await stat(idx);
      if (si.isFile()) return { file: idx, size: si.size };
    }
  } catch {
    // fall through to 404
  }
  return null;
}

const server = createServer(async (req, res) => {
  const t = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed\n');
  const { pathname } = new URL(req.url, 'http://x');
  const hit = await resolveFile(pathname);
  if (!hit) {
    send(res, 404, 'not found\n');
  } else {
    res.writeHead(200, {
      'content-type': MIME[extname(hit.file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': hit.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(hit.file).pipe(res);
  }
  console.log(`${res.statusCode} ${req.method} ${pathname} ${Date.now() - t}ms`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use (another serve.mjs still running?)` : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
  console.log(`serving ${ROOT}\n  http://${shown}:${PORT}/\nCtrl+C to stop`);
});

function shutdown(signal) {
  console.log(`\n${signal}: stopping`);
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
