import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vercelHandler from "../api/index.js";
import {
  convertQuestionMarksToPg,
  getDb,
  normalizeRow,
  resetDbForTesting,
} from "../server/db.mjs";
import { createAppServer } from "../server/index.mjs";

process.env.SESSION_SECRET = "test_secret_key_for_automated_verification_9876543210";
process.env.DATABASE_PATH = ":memory:";
process.env.ALLOW_REGISTRATION = "true";

async function startTestServer() {
  resetDbForTesting(new DatabaseSync(":memory:"));
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return { server, baseUrl };
}

function createClient(baseUrl) {
  let cookie = "";
  return {
    async request(path, { method = "GET", body, includeCsrf = true } = {}) {
      const headers = {};
      if (cookie) headers["Cookie"] = cookie;
      if (includeCsrf && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers["X-Requested-With"] = "PersonalWealth";
      }
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        cookie = setCookie.split(";")[0];
      }
      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : await res.text();
      return { status: res.status, data, headers: res.headers };
    },
  };
}

test("端到端核验：安全认证、权限隔离、防敏感卡号、资产负债公式、快照链与 Vercel 入口", async (t) => {
  // 校验 Postgres 占位符转换与 BIGINT 数值归一化工具
  assert.equal(
    convertQuestionMarksToPg("SELECT * FROM users WHERE id = ? AND username = ?"),
    "SELECT * FROM users WHERE id = $1 AND username = $2"
  );
  const norm = normalizeRow({ id: "12", net_worth_cents: "19520000", note: "ok" });
  assert.strictEqual(norm.id, 12);
  assert.strictEqual(norm.net_worth_cents, 19520000);

  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const alice = createClient(baseUrl);
  const bob = createClient(baseUrl);

  const unauthRes = await alice.request("/api/dashboard");
  assert.equal(unauthRes.status, 401);

  const csrfBlocked = await alice.request("/api/auth/register", {
    method: "POST",
    includeCsrf: false,
    body: { username: "alice", password: "password123" },
  });
  assert.equal(csrfBlocked.status, 403);

  const regAlice = await alice.request("/api/auth/register", {
    method: "POST",
    body: { username: "alice", password: "StrongPassword!2026" },
  });
  assert.equal(regAlice.status, 200);
  assert.match(regAlice.headers.get("set-cookie") || "", /HttpOnly/i);

  const db = await getDb();
  const userRow = await db.get(
    "SELECT password_hash FROM users WHERE username = ?",
    ["alice"]
  );
  assert.ok(userRow.password_hash.startsWith("scrypt$"));
  assert.ok(!userRow.password_hash.includes("StrongPassword!2026"));

  const fullCardRes = await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "招商银行",
      card_alias: "6225880112345678",
      credit_limit_yuan: "50000",
      current_debt_yuan: "1200",
    },
  });
  assert.equal(fullCardRes.status, 400);

  await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "招商银行",
      card_alias: "经典白 · 尾号8821",
      credit_limit_yuan: "50000",
      current_debt_yuan: "3200.50",
    },
  });
  await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "建设银行",
      card_alias: "大山白 · 尾号1099",
      credit_limit_yuan: "80000",
      current_debt_yuan: "1799.50",
    },
  });

  const initDash = (await alice.request("/api/dashboard")).data;
  const huabei = initDash.creditAccounts.find((c) => c.category === "huabei");
  const baitiao = initDash.creditAccounts.find((c) => c.category === "baitiao");
  const stock = initDash.fundAccounts.find((f) => f.category === "stock");
  const fund = initDash.fundAccounts.find((f) => f.category === "fund");
  const debit = initDash.fundAccounts.find((f) => f.category === "debit_card");
  const wechat = initDash.fundAccounts.find((f) => f.category === "wechat_pay");

  const quickRes = await alice.request("/api/quick-balances", {
    method: "POST",
    body: {
      funds: [
        { id: stock.id, balance_yuan: "100000", daily_pnl_yuan: "1250.50" },
        { id: fund.id, balance_yuan: "50000", daily_pnl_yuan: "-350.50" },
        { id: debit.id, balance_yuan: "40000", daily_pnl_yuan: "999" },
        { id: wechat.id, balance_yuan: "10000", daily_pnl_yuan: "0" },
      ],
      credits: [
        { id: huabei.id, current_debt_yuan: "800" },
        { id: baitiao.id, current_debt_yuan: "200" },
      ],
      saveSnapshot: false,
    },
  });
  assert.equal(quickRes.status, 200);

  await alice.request("/api/wool-records", {
    method: "POST",
    body: {
      record_date: "2026-11-26",
      item_name: "银行立减金券包",
      type: "instant_discount",
      cost_yuan: "0",
      face_value_yuan: "50",
      status: "pending",
      actual_income_yuan: "0",
      note: "满200可用",
    },
  });
  await alice.request("/api/wool-records", {
    method: "POST",
    body: {
      record_date: "2026-11-26",
      item_name: "活动礼盒闲鱼出手",
      type: "resale",
      cost_yuan: "100",
      face_value_yuan: "150",
      status: "sold",
      actual_income_yuan: "138.80",
      note: "已回款至微信",
    },
  });

  await alice.request("/api/stockpile-items", {
    method: "POST",
    body: {
      name: "囤货礼盒",
      quantity: 4,
      unit: "盒",
      cost_unit_price_yuan: "250",
      current_unit_price_yuan: "300",
      note: "自留库存",
    },
  });

  const dashCost = (await alice.request("/api/dashboard?date=2026-11-26")).data;
  assert.equal(dashCost.metrics.totalFundsCents, 20000000);
  assert.equal(dashCost.metrics.totalDebtCents, 600000);
  assert.equal(dashCost.metrics.totalCreditLimitCents, 13000000);
  assert.equal(dashCost.metrics.dailyInvestmentPnlCents, 90000);
  assert.equal(dashCost.metrics.woolTodayBalanceCents, 3880);
  assert.equal(dashCost.metrics.woolPendingFaceValueCents, 5000);
  assert.equal(dashCost.metrics.stockpileCostCents, 100000);
  assert.equal(dashCost.metrics.stockpileMarketCents, 120000);
  assert.equal(dashCost.metrics.netWorthCents, 19500000);

  await alice.request("/api/snapshots", {
    method: "POST",
    body: { snapshot_date: "2026-11-25" },
  });

  await alice.request("/api/settings", {
    method: "PATCH",
    body: { stockpile_valuation_mode: "market" },
  });

  await alice.request("/api/snapshots", {
    method: "POST",
    body: { snapshot_date: "2026-11-26" },
  });
  await alice.request("/api/snapshots", {
    method: "POST",
    body: { snapshot_date: "2026-11-26", note: "晚间更新" },
  });

  const dashAfterSnap = (await alice.request("/api/dashboard?date=2026-11-26")).data;
  assert.equal(dashAfterSnap.snapshots.length, 2);
  const snap26 = dashAfterSnap.snapshots[1];
  assert.equal(snap26.net_worth_cents, 19520000);
  assert.equal(snap26.net_worth_change_cents, 20000);
  assert.equal(snap26.prev_snapshot_date, "2026-11-25");
  assert.equal(snap26.stockpile_mode_used, "market");

  const regBob = await bob.request("/api/auth/register", {
    method: "POST",
    body: { username: "bob", password: "BobSecurePassword!99" },
  });
  assert.equal(regBob.status, 200);

  const bobDash = (await bob.request("/api/dashboard")).data;
  assert.equal(bobDash.metrics.netWorthCents, 0);

  const bobAttack = await bob.request(`/api/fund-accounts?id=${stock.id}`, {
    method: "DELETE",
  });
  assert.equal(bobAttack.status, 404);

  process.env.ALLOW_REGISTRATION = "false";
  const charlie = createClient(baseUrl);
  const regCharlie = await charlie.request("/api/auth/register", {
    method: "POST",
    body: { username: "charlie", password: "CharliePassword123" },
  });
  assert.equal(regCharlie.status, 403);

  // 验证 Vercel Serverless Rewrite 入口 (/api/index?__path=auth/status)
  const vercelSimServer = http.createServer((req, res) => vercelHandler(req, res));
  await new Promise((resolve) => vercelSimServer.listen(0, "127.0.0.1", resolve));
  t.after(() => vercelSimServer.close());
  const vPort = vercelSimServer.address().port;
  const vRes = await fetch(`http://127.0.0.1:${vPort}/api/index?__path=auth/status`);
  assert.equal(vRes.status, 200);
  const vData = await vRes.json();
  assert.equal(vData.hasAnyUser, true);
  assert.equal(vData.allowRegistration, false);
});
