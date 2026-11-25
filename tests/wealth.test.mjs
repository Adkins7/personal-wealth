import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resetDbForTesting, getDb } from "../server/db.mjs";
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

test("端到端核验：安全认证、权限隔离、防敏感卡号、资产负债公式与每日快照链", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const alice = createClient(baseUrl);
  const bob = createClient(baseUrl);

  // 1. 未登录禁止访问业务接口；缺少 CSRF 头的写请求被拦截
  const unauthRes = await alice.request("/api/dashboard");
  assert.equal(unauthRes.status, 401);

  const csrfBlocked = await alice.request("/api/auth/register", {
    method: "POST",
    includeCsrf: false,
    body: { username: "alice", password: "password123" },
  });
  assert.equal(csrfBlocked.status, 403);

  // 2. 注册 Alice 并验证密码哈希存储（绝不明文入库）与 HttpOnly Cookie
  const regAlice = await alice.request("/api/auth/register", {
    method: "POST",
    body: { username: "alice", password: "StrongPassword!2026" },
  });
  assert.equal(regAlice.status, 200);
  assert.match(regAlice.headers.get("set-cookie") || "", /HttpOnly/i);

  const db = getDb();
  const userRow = db.prepare("SELECT password_hash FROM users WHERE username = 'alice'").get();
  assert.ok(userRow.password_hash.startsWith("scrypt$"));
  assert.ok(!userRow.password_hash.includes("StrongPassword!2026"));

  // 3. 隐私红线测试：禁止录入完整银行卡号
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

  // 4. 录入多银行多张信用卡 + 更新花呗与白条
  //    招行卡：授信 50,000，欠款 3,200.50
  //    建行卡：授信 80,000，欠款 1,799.50
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

  // 花呗欠款 800.00，白条欠款 200.00 => 负债总额应为 3200.50 + 1799.50 + 800 + 200 = 6,000.00 元 (600,000 分)
  // 信用卡总授信 = 50,000 + 80,000 = 130,000.00 元（仅展示，绝不计入负债或资产）
  const stock = initDash.fundAccounts.find((f) => f.category === "stock");
  const fund = initDash.fundAccounts.find((f) => f.category === "fund");
  const debit = initDash.fundAccounts.find((f) => f.category === "debit_card");
  const wechat = initDash.fundAccounts.find((f) => f.category === "wechat_pay");

  // 股票余额 100,000 (当日盈亏 +1,250.50)
  // 支付宝基金 50,000 (当日盈亏 -350.50) -> 当日投资盈亏 = +900.00 元
  // 储蓄卡 40,000，微信零钱 10,000 -> 资金总额 = 200,000.00 元
  const quickRes = await alice.request("/api/quick-balances", {
    method: "POST",
    body: {
      funds: [
        { id: stock.id, balance_yuan: "100000", daily_pnl_yuan: "1250.50" },
        { id: fund.id, balance_yuan: "50000", daily_pnl_yuan: "-350.50" },
        { id: debit.id, balance_yuan: "40000", daily_pnl_yuan: "999" }, // 现金类账户应强制忽略盈亏
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

  // 5. 录入薅羊毛：
  //    A. 未兑现立减金：成本 0，面值 50 元，状态 pending -> 实际盈亏必须为 0，不当现金！
  //    B. 已售出羊毛：成本 100，面值 150，实际收入 138.80，状态 sold -> 实际盈亏 +38.80，独立统计，不计入净资产！
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

  // 6. 录入囤货：数量 4 盒，成本单价 250 元（合计 1,000 元），当前估值单价 300 元（合计 1,200 元）
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

  // 核对默认成本口径下的所有指标：
  // 资金总额 = 200,000.00 元 (20,000,000 分)
  // 负债总额 = 6,000.00 元 (600,000 分)
  // 囤货(成本口径) = 1,000.00 元 (100,000 分)
  // 净资产 = 200,000 - 6,000 + 1,000 = 195,000.00 元 (19,500,000 分) —— 注意：羊毛 +38.80 绝不计入净资产！
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

  // 保存 2026-11-25 快照（净资产 195,000 元）
  await alice.request("/api/snapshots", {
    method: "POST",
    body: { snapshot_date: "2026-11-25" },
  });

  // 切换囤货统计口径为“当前估值” -> 净资产应变为 200,000 - 6,000 + 1,200 = 195,200.00 元
  await alice.request("/api/settings", {
    method: "PATCH",
    body: { stockpile_valuation_mode: "market" },
  });

  // 保存两次 2026-11-26 快照，验证同日覆盖更新且不重复新增行，较前日变化 = +200.00 元 (20,000 分)
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

  // 7. 多用户严格数据隔离测试：注册 Bob，验证看不到也改不了 Alice 的任何数据
  const regBob = await bob.request("/api/auth/register", {
    method: "POST",
    body: { username: "bob", password: "BobSecurePassword!99" },
  });
  assert.equal(regBob.status, 200);

  const bobDash = (await bob.request("/api/dashboard")).data;
  assert.equal(bobDash.metrics.netWorthCents, 0);
  assert.equal(bobDash.woolRecords.length, 0);
  assert.equal(bobDash.stockpileItems.length, 0);
  assert.equal(bobDash.snapshots.length, 0);

  // Bob 尝试删除 Alice 的资金账户应返回 404
  const bobAttack = await bob.request(`/api/fund-accounts?id=${stock.id}`, {
    method: "DELETE",
  });
  assert.equal(bobAttack.status, 404);

  // 8. 验证 ALLOW_REGISTRATION=false 关闭公开注册生效
  process.env.ALLOW_REGISTRATION = "false";
  const charlie = createClient(baseUrl);
  const regCharlie = await charlie.request("/api/auth/register", {
    method: "POST",
    body: { username: "charlie", password: "CharliePassword123" },
  });
  assert.equal(regCharlie.status, 403);

  // 9. 验证 CSV 与 JSON 备份导出
  const csvRes = await alice.request("/api/export?format=csv");
  assert.equal(csvRes.status, 200);
  assert.ok(String(csvRes.data).includes("当日净资产(元)"));
  assert.ok(String(csvRes.data).includes("195200.00"));
});
