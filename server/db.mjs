import fs from "node:fs";
import path from "node:path";

/**
 * 多引擎异步数据库适配层：
 * 1. 云端 Neon PostgreSQL（自动识别 DATABASE_URL / POSTGRES_URL，Vercel Storage 一键接入）
 * 2. 云端 Turso SQLite（自动识别 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN）
 * 3. 本地 Node 22 原生 SQLite（默认 ./data/wealth.db 或测试 :memory:）
 */

let dbPromise = null;

const NUMERIC_COLS = new Set([
  "id",
  "user_id",
  "cnt",
  "attempts",
  "window_start",
  "sort_order",
  "quantity",
]);

export function normalizeRow(row) {
  if (!row || typeof row !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (NUMERIC_COLS.has(k) || k.endsWith("_cents")) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function convertQuestionMarksToPg(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

const SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    stockpile_valuation_mode TEXT NOT NULL DEFAULT 'cost' CHECK(stockpile_valuation_mode IN ('cost', 'market')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credit_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('credit_card', 'huabei', 'baitiao', 'other')),
    bank_or_platform TEXT NOT NULL,
    card_alias TEXT NOT NULL DEFAULT '',
    credit_limit_cents INTEGER NOT NULL DEFAULT 0,
    current_debt_cents INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_accounts_user ON credit_accounts(user_id)`,
  `CREATE TABLE IF NOT EXISTS fund_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('stock', 'fund', 'debit_card', 'wechat_pay', 'other')),
    name TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    daily_pnl_cents INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fund_accounts_user ON fund_accounts(user_id)`,
  `CREATE TABLE IF NOT EXISTS wool_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_date TEXT NOT NULL,
    item_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('instant_discount', 'coupon', 'resale', 'cashback', 'other')),
    cost_cents INTEGER NOT NULL DEFAULT 0,
    face_value_cents INTEGER NOT NULL DEFAULT 0,
    actual_income_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sold', 'expired')),
    actual_pnl_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wool_records_user_date ON wool_records(user_id, record_date DESC)`,
  `CREATE TABLE IF NOT EXISTS stockpile_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '件',
    cost_unit_price_cents INTEGER NOT NULL DEFAULT 0,
    current_unit_price_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stockpile_items_user ON stockpile_items(user_id)`,
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_date TEXT NOT NULL,
    total_funds_cents INTEGER NOT NULL,
    total_debt_cents INTEGER NOT NULL,
    stockpile_cost_cents INTEGER NOT NULL,
    stockpile_market_cents INTEGER NOT NULL,
    stockpile_value_cents INTEGER NOT NULL,
    stockpile_mode_used TEXT NOT NULL CHECK(stockpile_mode_used IN ('cost', 'market')),
    net_worth_cents INTEGER NOT NULL,
    net_worth_change_cents INTEGER,
    prev_snapshot_date TEXT,
    daily_investment_pnl_cents INTEGER NOT NULL,
    wool_daily_balance_cents INTEGER NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, snapshot_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_snapshots_user_date ON daily_snapshots(user_id, snapshot_date ASC)`,
];

const POSTGRES_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    stockpile_valuation_mode TEXT NOT NULL DEFAULT 'cost' CHECK(stockpile_valuation_mode IN ('cost', 'market')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_start BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credit_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('credit_card', 'huabei', 'baitiao', 'other')),
    bank_or_platform TEXT NOT NULL,
    card_alias TEXT NOT NULL DEFAULT '',
    credit_limit_cents BIGINT NOT NULL DEFAULT 0,
    current_debt_cents BIGINT NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_accounts_user ON credit_accounts(user_id)`,
  `CREATE TABLE IF NOT EXISTS fund_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('stock', 'fund', 'debit_card', 'wechat_pay', 'other')),
    name TEXT NOT NULL,
    balance_cents BIGINT NOT NULL DEFAULT 0,
    daily_pnl_cents BIGINT NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fund_accounts_user ON fund_accounts(user_id)`,
  `CREATE TABLE IF NOT EXISTS wool_records (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_date TEXT NOT NULL,
    item_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('instant_discount', 'coupon', 'resale', 'cashback', 'other')),
    cost_cents BIGINT NOT NULL DEFAULT 0,
    face_value_cents BIGINT NOT NULL DEFAULT 0,
    actual_income_cents BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sold', 'expired')),
    actual_pnl_cents BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wool_records_user_date ON wool_records(user_id, record_date DESC)`,
  `CREATE TABLE IF NOT EXISTS stockpile_items (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '件',
    cost_unit_price_cents BIGINT NOT NULL DEFAULT 0,
    current_unit_price_cents BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stockpile_items_user ON stockpile_items(user_id)`,
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_date TEXT NOT NULL,
    total_funds_cents BIGINT NOT NULL,
    total_debt_cents BIGINT NOT NULL,
    stockpile_cost_cents BIGINT NOT NULL,
    stockpile_market_cents BIGINT NOT NULL,
    stockpile_value_cents BIGINT NOT NULL,
    stockpile_mode_used TEXT NOT NULL CHECK(stockpile_mode_used IN ('cost', 'market')),
    net_worth_cents BIGINT NOT NULL,
    net_worth_change_cents BIGINT,
    prev_snapshot_date TEXT,
    daily_investment_pnl_cents BIGINT NOT NULL,
    wool_daily_balance_cents BIGINT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, snapshot_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_snapshots_user_date ON daily_snapshots(user_id, snapshot_date ASC)`,
];

function createLocalSqliteAdapter(rawDb) {
  rawDb.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  for (const ddl of SQLITE_DDL) {
    rawDb.exec(ddl);
  }
  return {
    dialect: "sqlite",
    raw: rawDb,
    async get(sql, params = []) {
      const row = rawDb.prepare(sql).get(...params);
      return normalizeRow(row);
    },
    async all(sql, params = []) {
      const rows = rawDb.prepare(sql).all(...params);
      return rows.map((r) => normalizeRow(r));
    },
    async run(sql, params = []) {
      const res = rawDb.prepare(sql).run(...params);
      return {
        changes: Number(res.changes ?? 0),
        lastInsertRowid: Number(res.lastInsertRowid ?? 0),
      };
    },
    async batch(statements) {
      rawDb.exec("BEGIN");
      try {
        for (const stmt of statements) {
          rawDb.prepare(stmt.sql).run(...(stmt.params || []));
        }
        rawDb.exec("COMMIT");
      } catch (err) {
        rawDb.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      rawDb.close();
    },
  };
}

async function createTursoAdapter(url, authToken) {
  const { createClient } = await import("@libsql/client/web");
  const client = createClient({ url, authToken });
  await client.batch(
    ["PRAGMA foreign_keys = ON", ...SQLITE_DDL].map((sql) => ({ sql, args: [] })),
    "write"
  );
  return {
    dialect: "turso",
    async get(sql, params = []) {
      const res = await client.execute({ sql, args: params });
      return normalizeRow(res.rows[0]);
    },
    async all(sql, params = []) {
      const res = await client.execute({ sql, args: params });
      return res.rows.map((r) => normalizeRow(r));
    },
    async run(sql, params = []) {
      const res = await client.execute({ sql, args: params });
      return {
        changes: Number(res.rowsAffected ?? 0),
        lastInsertRowid: Number(res.lastInsertRowid ?? 0),
      };
    },
    async batch(statements) {
      await client.batch(
        statements.map((s) => ({ sql: s.sql, args: s.params || [] })),
        "write"
      );
    },
    close() {
      client.close();
    },
  };
}

async function createNeonPostgresAdapter(connectionString) {
  const { neon } = await import("@neondatabase/serverless");
  const sqlClient = neon(connectionString);
  await sqlClient.transaction((txn) => POSTGRES_DDL.map((ddl) => txn.query(ddl)));

  return {
    dialect: "postgres",
    async get(sql, params = []) {
      const pgSql = convertQuestionMarksToPg(sql);
      const rows = await sqlClient.query(pgSql, params);
      return normalizeRow(rows[0]);
    },
    async all(sql, params = []) {
      const pgSql = convertQuestionMarksToPg(sql);
      const rows = await sqlClient.query(pgSql, params);
      return rows.map((r) => normalizeRow(r));
    },
    async run(sql, params = []) {
      const pgSql = convertQuestionMarksToPg(sql);
      const res = await sqlClient.query(pgSql, params, { fullResults: true });
      return {
        changes: Number(res.rowCount ?? 0),
      };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      await sqlClient.transaction((txn) =>
        statements.map((s) => txn.query(convertQuestionMarksToPg(s.sql), s.params || []))
      );
    },
    close() {},
  };
}

async function initDbAdapter() {
  const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (pgUrl.startsWith("postgres://") || pgUrl.startsWith("postgresql://")) {
    return createNeonPostgresAdapter(pgUrl);
  }

  const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || "";
  if (tursoUrl) {
    return createTursoAdapter(tursoUrl, process.env.TURSO_AUTH_TOKEN);
  }

  if (process.env.VERCEL) {
    throw new Error(
      "尚未连接云数据库：请在 Vercel 项目顶部的 Storage 选项卡点击 Create Database，选择 Neon (Postgres) 或 Turso 连接至本项目，然后重新部署（Redeploy）。"
    );
  }

  const { DatabaseSync } = await import("node:sqlite");
  const configured = process.env.DATABASE_PATH || "./data/wealth.db";
  const dbPath =
    configured === ":memory:"
      ? ":memory:"
      : path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  return createLocalSqliteAdapter(new DatabaseSync(dbPath));
}

export function getDb() {
  if (!dbPromise) {
    dbPromise = initDbAdapter().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export function resetDbForTesting(customRawSqliteDb) {
  dbPromise = customRawSqliteDb
    ? Promise.resolve(createLocalSqliteAdapter(customRawSqliteDb))
    : null;
}
