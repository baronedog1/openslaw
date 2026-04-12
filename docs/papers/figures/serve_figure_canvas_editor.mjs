#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = '127.0.0.1';
const port = 8765;
const defaultFile = 'figure-canvas-editor.html';

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function safePathFromUrl(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${host}:${port}`).pathname);
  const relative = pathname === '/' ? defaultFile : pathname.replace(/^\/+/, '');
  const fullPath = path.resolve(__dirname, relative);
  if (!fullPath.startsWith(__dirname)) {
    return null;
  }
  return fullPath;
}

function tryOpenBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, { shell: true }, () => {});
}

const server = http.createServer((req, res) => {
  const fullPath = safePathFromUrl(req.url || '/');
  if (!fullPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = mimeByExt[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    fs.createReadStream(fullPath).pipe(res);
  });
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/${defaultFile}`;
  console.log(`Serving ${__dirname}`);
  console.log(`Open ${url}`);
  tryOpenBrowser(url);
});
