import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionSecret } from "./auth.mjs";
import { getDb } from "./db.mjs";
import { loadEnvFile } from "./env.mjs";
import { handleApiRequest } from "./routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

loadEnvFile();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function createAppServer() {
  // 启动时验证安全密钥与初始化数据库
  getSessionSecret();
  getDb();

  return http.createServer(async (req, res) => {
    const host = req.headers.host || "localhost";
    const urlObj = new URL(req.url || "/", `http://${host}`);

    if (urlObj.pathname.startsWith("/api/")) {
      return handleApiRequest(req, res, urlObj);
    }

    // 静态文件服务（严格限制在 public 目录内，防止目录穿越）
    let relPath = urlObj.pathname === "/" ? "/index.html" : urlObj.pathname;
    try {
      relPath = decodeURIComponent(relPath);
    } catch {
      res.writeHead(400);
      return res.end("Bad Request");
    }

    const resolvedPath = path.resolve(PUBLIC_DIR, "." + relPath);
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    let filePath = resolvedPath;
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(content);
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT || 3080);
  const host = process.env.HOST || "127.0.0.1";
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`Personal Ledger 已启动: http://${host}:${port}`);
  });
}
