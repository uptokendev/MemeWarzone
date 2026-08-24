import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const port = Number(process.env.PLAYWRIGHT_PREVIEW_PORT || 4173);
const host = "127.0.0.1";

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const requested = path.resolve(dist, relative || "index.html");
    if (!requested.startsWith(dist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const index = path.join(dist, "index.html");
    const typeFor = (file) => mime[path.extname(file).toLowerCase()] || "application/octet-stream";
    fs.stat(requested, (error, stats) => {
      const file = !error && stats.isFile() ? requested : index;
      res.writeHead(200, { "content-type": typeFor(file) });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(port, host, () => {
    console.log(`[e2e] SPA preview http://${host}:${port} -> ${dist}`);
  });
