#!/usr/bin/env node
/**
 * 开发用静态服务器。浏览器里 ES module 不能用 file:// 加载，
 * 所以需要一个小 HTTP 服务把仓库根目录暴露出去。
 *
 *   npm run web        # http://127.0.0.1:5173/examples/browser.html
 */

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const target = resolve(join(ROOT, normalize(urlPath === '/' ? '/index.html' : urlPath)));

    // 目录穿越防护
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = target;
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!statSync(file).isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`静态服务已启动：http://127.0.0.1:${PORT}`);
    console.log(`浏览器 Demo：http://127.0.0.1:${PORT}/examples/browser.html`);
  });
