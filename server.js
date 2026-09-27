// ローカル確認用の小さな静的サーバー（依存パッケージなし）。
//   npm start → http://localhost:8080
// - /vendor/mediapipe/* は node_modules の MediaPipe を配信
// - POST /api/save-avatar でパーツ調整モードの設定を avatar/avatar.json に保存
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const mediapipeDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveSafe(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

async function serveFile(res, file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && path === '/api/save-avatar') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      try {
        const json = JSON.parse(body);
        await writeFile(join(root, 'avatar', 'avatar.json'), JSON.stringify(json, null, 2) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  let file;
  if (path.startsWith('/vendor/mediapipe/')) {
    file = resolveSafe(mediapipeDir, path.slice('/vendor/mediapipe/'.length));
  } else {
    file = resolveSafe(root, path === '/' ? 'index.html' : path.slice(1));
  }
  if (!file || file.includes(`${sep}node_modules${sep}`) && !file.startsWith(mediapipeDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  await serveFile(res, file);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`VTuber アバター: http://localhost:${PORT}`);
});
