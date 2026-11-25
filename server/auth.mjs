import crypto from "node:crypto";
import { getDb } from "./db.mjs";
import { getNowTimestampString } from "./money.mjs";

export const SESSION_COOKIE_NAME = "pw_session";
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 天
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (
    !secret ||
    secret.length < 16 ||
    secret === "replace_with_random_32_byte_hex_secret"
  ) {
    throw new Error(
      "未配置安全的 SESSION_SECRET 环境变量：请在 .env 或 Vercel 项目 Settings -> Environment Variables 中设置至少 16 位的随机密钥"
    );
  }
  return secret;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (!N || !r || !p || salt.length === 0 || expected.length === 0) return false;

  const derived = crypto.scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(derived, expected);
}

export function hashSessionToken(rawToken) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(rawToken)
    .digest("hex");
}

export async function getAuthStatus() {
  const db = await getDb();
  const countRow = await db.get("SELECT COUNT(*) as cnt FROM users");
  const userCount = Number(countRow?.cnt ?? 0);
  const envVal = String(process.env.ALLOW_REGISTRATION ?? "true")
    .toLowerCase()
    .trim();
  const envAllows = envVal === "true" || envVal === "1" || envVal === "yes";
  return {
    hasAnyUser: userCount > 0,
    allowRegistration: userCount === 0 ? true : envAllows,
  };
}

export async function checkLoginRateLimit(key) {
  const db = await getDb();
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 8;

  const row = await db.get(
    "SELECT attempts, window_start FROM login_attempts WHERE attempt_key = ?",
    [key]
  );

  if (!row) return { allowed: true };
  if (now - row.window_start > windowMs) {
    await db.run("DELETE FROM login_attempts WHERE attempt_key = ?", [key]);
    return { allowed: true };
  }
  if (row.attempts >= maxAttempts) {
    const retryAfterSec = Math.ceil((windowMs - (now - row.window_start)) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

export async function recordLoginFailure(key) {
  const db = await getDb();
  const now = Date.now();
  const row = await db.get(
    "SELECT attempts, window_start FROM login_attempts WHERE attempt_key = ?",
    [key]
  );
  if (!row || now - row.window_start > 15 * 60 * 1000) {
    await db.run(
      `INSERT INTO login_attempts (attempt_key, attempts, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET attempts = 1, window_start = excluded.window_start`,
      [key, now]
    );
  } else {
    await db.run(
      "UPDATE login_attempts SET attempts = attempts + 1 WHERE attempt_key = ?",
      [key]
    );
  }
}

export async function clearLoginFailures(key) {
  const db = await getDb();
  await db.run("DELETE FROM login_attempts WHERE attempt_key = ?", [key]);
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function issueSessionCookie(userId, req) {
  const db = await getDb();
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await db.run(
    "INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [userId, tokenHash, expiresAt.toISOString(), getNowTimestampString()]
  );

  const isSecure =
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.VERCEL) ||
    process.env.HTTPS === "true" ||
    req?.headers?.["x-forwarded-proto"] === "https";

  const parts = [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export async function revokeSessionByRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (rawToken) {
    try {
      const db = await getDb();
      const tokenHash = hashSessionToken(rawToken);
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    } catch {
      // ignore
    }
  }
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return null;

  let tokenHash;
  try {
    tokenHash = hashSessionToken(rawToken);
  } catch {
    return null;
  }

  const db = await getDb();
  const row = await db.get(
    `SELECT u.id, u.username, u.stockpile_valuation_mode, u.monthly_budget_cents, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [tokenHash]
  );

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }

  return {
    id: Number(row.id),
    username: row.username,
    stockpile_valuation_mode: row.stockpile_valuation_mode,
    monthly_budget_cents: Number(row.monthly_budget_cents ?? 0),
  };
}
