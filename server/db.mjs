import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let dbInstance = null;

export function getDbPath() {
  const configured = process.env.DATABASE_PATH || "./data/wealth.db";
  if (configured === ":memory:") return ":memory:";
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

export function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      stockpile_valuation_mode TEXT NOT NULL DEFAULT 'cost' CHECK(stockpile_valuation_mode IN ('cost', 'market')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      attempt_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credit_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('credit_card', 'huabei', 'baitiao', 'other')),
      bank_or_platform TEXT NOT NULL,
      card_alias TEXT NOT NULL DEFAULT '',
      credit_limit_cents INTEGER NOT NULL DEFAULT 0,
      current_debt_cents INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_credit_accounts_user ON credit_accounts(user_id);

    CREATE TABLE IF NOT EXISTS fund_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('stock', 'fund', 'debit_card', 'wechat_pay', 'other')),
      name TEXT NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      daily_pnl_cents INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_fund_accounts_user ON fund_accounts(user_id);

    CREATE TABLE IF NOT EXISTS wool_records (
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
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_wool_records_user_date ON wool_records(user_id, record_date DESC);

    CREATE TABLE IF NOT EXISTS stockpile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT '件',
      cost_unit_price_cents INTEGER NOT NULL DEFAULT 0,
      current_unit_price_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_stockpile_items_user ON stockpile_items(user_id);

    CREATE TABLE IF NOT EXISTS daily_snapshots (
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_snapshots_user_date ON daily_snapshots(user_id, snapshot_date ASC);
  `);
}

export function getDb() {
  if (!dbInstance) {
    const dbPath = getDbPath();
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    dbInstance = new DatabaseSync(dbPath);
    initSchema(dbInstance);
  }
  return dbInstance;
}

export function resetDbForTesting(customDb) {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
  }
  dbInstance = customDb || null;
  if (dbInstance) {
    initSchema(dbInstance);
  }
}
