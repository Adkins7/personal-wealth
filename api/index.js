import { loadEnvFile } from "../server/env.mjs";
import { handleApiRequest } from "../server/routes.mjs";

loadEnvFile();

export default async function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const urlObj = new URL(req.url || "/", `${proto}://${host}`);

  // 兼容 Vercel rewrites 将 /api/(.*) 转发至 /api/index?__path=$1 的情况
  const rewrittenSubpath = urlObj.searchParams.get("__path");
  if (
    rewrittenSubpath !== null &&
    (urlObj.pathname === "/api/index" ||
      urlObj.pathname === "/api/index.js" ||
      urlObj.pathname === "/api")
  ) {
    urlObj.pathname = `/api/${rewrittenSubpath}`;
  }

  return handleApiRequest(req, res, urlObj);
}
