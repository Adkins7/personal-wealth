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
    async request(
      path,
      { method = "GET", body, includeCsrf = true, extraHeaders = {} } = {}
    ) {
      const headers = { ...extraHeaders };
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

  // 防呆校验：新建信用卡未填剩余额度应拦截
  const missingRemRes = await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "招商银行",
      card_alias: "测试卡",
      credit_limit_yuan: "50000",
    },
  });
  assert.equal(missingRemRes.status, 400);

  // 招行卡：授信 50,000，剩余额度 46,799.50 => 自动算出欠款 3,200.50 元
  await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "招商银行",
      card_alias: "经典白 · 尾号8821",
      credit_limit_yuan: "50000",
      remaining_limit_yuan: "46799.50",
    },
  });
  // 建行卡：先测溢缴款场景（授信 80,000，剩余额度 80,100 => 欠款按 0 计入）
  const ccbCreate = await alice.request("/api/credit-accounts", {
    method: "POST",
    body: {
      category: "credit_card",
      bank_or_platform: "建设银行",
      card_alias: "大山白 · 尾号1099",
      credit_limit_yuan: "80000",
      remaining_limit_yuan: "80100",
    },
  });
  assert.equal(ccbCreate.status, 200);

  const initDash = (await alice.request("/api/dashboard")).data;
  const ccbCard = initDash.creditAccounts.find((c) => c.bank_or_platform === "建设银行");
  assert.equal(ccbCard.current_debt_cents, 0);
  assert.equal(ccbCard.remaining_limit_cents, 8010000);

  const huabei = initDash.creditAccounts.find((c) => c.category === "huabei");
  const baitiao = initDash.creditAccounts.find((c) => c.category === "baitiao");
  const stock = initDash.fundAccounts.find((f) => f.category === "stock");
  const fund = initDash.fundAccounts.find((f) => f.category === "fund");
  const debit = initDash.fundAccounts.find((f) => f.category === "debit_card");
  const wechat = initDash.fundAccounts.find((f) => f.category === "wechat_pay");

  // 快速盘点：建行卡剩余额度改为 78,200.50 => 自动算出欠款 1,799.50 元；花呗/白条直接填欠款
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
        { id: ccbCard.id, remaining_limit_yuan: "78200.50" },
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

  // 录入每日消费：日常餐饮 45.50 + 日常交通 14.50 + 大额房租 3000.00（标记 is_large=true）
  await alice.request("/api/settings", {
    method: "PATCH",
    body: { monthly_budget_yuan: "5000" },
  });
  const exp1 = await alice.request("/api/expenses", {
    method: "POST",
    body: {
      expense_date: "2026-11-26",
      category: "dining",
      amount_yuan: "45.50",
      note: "午餐",
    },
  });
  assert.equal(exp1.status, 200);
  await alice.request("/api/expenses", {
    method: "POST",
    body: {
      expense_date: "2026-11-26",
      category: "transport",
      amount_yuan: "14.50",
      note: "打车",
    },
  });
  await alice.request("/api/expenses", {
    method: "POST",
    body: {
      expense_date: "2026-11-26",
      category: "housing",
      amount_yuan: "3000",
      is_large: true,
      note: "月度房租",
    },
  });

  const dashCost = (await alice.request("/api/dashboard?date=2026-11-26")).data;
  assert.equal(dashCost.metrics.totalFundsCents, 20000000);
  assert.equal(dashCost.metrics.totalDebtCents, 600000);
  assert.equal(dashCost.metrics.totalCreditLimitCents, 13000000);
  assert.equal(dashCost.metrics.dailyInvestmentPnlCents, 90000);
  assert.equal(dashCost.metrics.woolTodayBalanceCents, 3880);
  assert.equal(dashCost.metrics.woolPendingFaceValueCents, 5000);
  assert.equal(dashCost.metrics.expenseTodayCents, 306000);
  assert.equal(dashCost.metrics.expenseMonthTotalCents, 306000);
  assert.equal(dashCost.metrics.expenseMonthRegularCents, 6000);
  assert.equal(dashCost.metrics.monthlyBudgetCents, 500000);
  assert.equal(dashCost.metrics.stockpileCostCents, 100000);
  assert.equal(dashCost.metrics.stockpileMarketCents, 120000);
  // 净资产绝不二次扣减每日消费流水
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
  assert.equal(snap26.daily_expense_cents, 306000);

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

  // 验证快速连点防重幂等键：并发发送两次携带相同 X-Idempotency-Key 的 POST 请求只写入 1 条记录
  const dupBody = {
    name: "花旦币",
    quantity: 1,
    unit: "件",
    cost_unit_price_yuan: "100",
  };
  await Promise.all([
    bob.request("/api/stockpile-items", {
      method: "POST",
      body: dupBody,
      extraHeaders: { "X-Idempotency-Key": "POST:/api/stockpile-items:testkey1" },
    }),
    bob.request("/api/stockpile-items", {
      method: "POST",
      body: dupBody,
      extraHeaders: { "X-Idempotency-Key": "POST:/api/stockpile-items:testkey1" },
    }),
  ]);
  const bobAfterDup = (await bob.request("/api/dashboard")).data;
  assert.equal(bobAfterDup.stockpileItems.length, 1);

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
