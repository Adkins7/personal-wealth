import {
  checkLoginRateLimit,
  clearLoginFailures,
  getAuthStatus,
  getSessionSecret,
  getUserFromRequest,
  hashPassword,
  issueSessionCookie,
  recordLoginFailure,
  revokeSessionByRequest,
  verifyPassword,
} from "./auth.mjs";
import { getDb } from "./db.mjs";
import {
  centsToYuanString,
  getLocalDateString,
  getNowTimestampString,
  yuanToCents,
} from "./money.mjs";
import {
  computeWoolActualPnl,
  getDashboardPayload,
  recomputeSnapshotChain,
  seedDefaultAccountsForNewUser,
} from "./summary.mjs";

const VALID_CREDIT_CATEGORIES = ["credit_card", "huabei", "baitiao", "other"];
const VALID_FUND_CATEGORIES = ["stock", "fund", "debit_card", "wechat_pay", "other"];
const VALID_WOOL_TYPES = ["instant_discount", "coupon", "resale", "cashback", "other"];
const VALID_WOOL_STATUSES = ["pending", "sold", "expired"];

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }
  const chunks = [];
  let totalLen = 0;
  for await (const chunk of req) {
    totalLen += chunk.length;
    if (totalLen > 1024 * 1024) {
      throw new Error("请求体过大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("无效的 JSON 请求格式");
  }
}

function containsFullCardNumber(text) {
  const digitsOnly = String(text || "").replace(/[\s-]/g, "");
  return /\d{12,19}/.test(digitsOnly);
}

function csvEscape(val) {
  const str = val === null || val === undefined ? "" : String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function handleApiRequest(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;
  const method = req.method || "GET";

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfHeader = req.headers["x-requested-with"];
    if (csrfHeader !== "PersonalWealth") {
      return sendJson(res, 403, { error: "安全校验未通过（缺少有效请求标识）" });
    }
  }

  try {
    // 校验 SESSION_SECRET 环境变量是否已配置
    getSessionSecret();

    // 1. 认证状态查询
    if (pathname === "/api/auth/status" && method === "GET") {
      const [user, status] = await Promise.all([
        getUserFromRequest(req),
        getAuthStatus(),
      ]);
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        user,
        ...status,
      });
    }

    // 2. 注册账号
    if (pathname === "/api/auth/register" && method === "POST") {
      const { allowRegistration } = await getAuthStatus();
      if (!allowRegistration) {
        return sendJson(res, 403, {
          error: "当前站点已关闭公开注册（ALLOW_REGISTRATION=false）",
        });
      }
      const body = await readJsonBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");

      if (username.length < 2 || username.length > 32) {
        return sendJson(res, 400, { error: "用户名长度需在 2 到 32 个字符之间" });
      }
      if (password.length < 8 || password.length > 128) {
        return sendJson(res, 400, { error: "密码长度至少需要 8 位" });
      }

      const db = await getDb();
      const existing = await db.get(
        "SELECT id FROM users WHERE lower(username) = lower(?)",
        [username]
      );
      if (existing) {
        return sendJson(res, 409, { error: "该用户名已被使用" });
      }

      const passwordHash = hashPassword(password);
      const inserted = await db.get(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id",
        [username, passwordHash, getNowTimestampString()]
      );

      const userId = Number(inserted.id);
      await seedDefaultAccountsForNewUser(userId);
      const cookie = await issueSessionCookie(userId, req);

      return sendJson(
        res,
        200,
        { ok: true, user: { id: userId, username } },
        { "Set-Cookie": cookie }
      );
    }

    // 3. 登录账号
    if (pathname === "/api/auth/login" && method === "POST") {
      const body = await readJsonBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");

      if (!username || !password) {
        return sendJson(res, 400, { error: "请输入用户名和密码" });
      }

      const forwarded =
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local";
      const ip = String(forwarded).split(",")[0].trim();
      const limitKey = `${ip}:${username.toLowerCase()}`;

      const rate = await checkLoginRateLimit(limitKey);
      if (!rate.allowed) {
        return sendJson(res, 429, {
          error: `登录尝试过多，请在 ${rate.retryAfterSec} 秒后重试`,
        });
      }

      const db = await getDb();
      const row = await db.get(
        "SELECT id, username, password_hash FROM users WHERE lower(username) = lower(?)",
        [username]
      );

      if (!row || !verifyPassword(password, row.password_hash)) {
        await recordLoginFailure(limitKey);
        return sendJson(res, 401, { error: "用户名或密码不正确" });
      }

      await clearLoginFailures(limitKey);
      const cookie = await issueSessionCookie(Number(row.id), req);
      return sendJson(
        res,
        200,
        { ok: true, user: { id: Number(row.id), username: row.username } },
        { "Set-Cookie": cookie }
      );
    }

    // 4. 退出登录
    if (pathname === "/api/auth/logout" && method === "POST") {
      const clearCookie = await revokeSessionByRequest(req);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearCookie });
    }

    // === 以下所有接口均强制要求已登录，并严格按 user.id 隔离个人数据 ===
    const user = await getUserFromRequest(req);
    if (!user) {
      return sendJson(res, 401, { error: "登录会话已失效，请重新登录" });
    }

    // 5. 仪表盘聚合数据
    if (pathname === "/api/dashboard" && method === "GET") {
      const dateParam = searchParams.get("date") || undefined;
      const payload = await getDashboardPayload(user, dateParam);
      return sendJson(res, 200, payload);
    }

    // 6. 偏好设置与密码修改
    if (pathname === "/api/settings" && method === "PATCH") {
      const body = await readJsonBody(req);
      const db = await getDb();

      if (body.stockpile_valuation_mode !== undefined) {
        const mode = body.stockpile_valuation_mode;
        if (mode !== "cost" && mode !== "market") {
          return sendJson(res, 400, { error: "无效的囤货统计口径" });
        }
        await db.run("UPDATE users SET stockpile_valuation_mode = ? WHERE id = ?", [
          mode,
          user.id,
        ]);
      }

      if (body.newPassword !== undefined) {
        const currentPassword = String(body.currentPassword ?? "");
        const newPassword = String(body.newPassword ?? "");
        if (newPassword.length < 8) {
          return sendJson(res, 400, { error: "新密码长度至少需要 8 位" });
        }
        const row = await db.get("SELECT password_hash FROM users WHERE id = ?", [
          user.id,
        ]);
        if (!row || !verifyPassword(currentPassword, row.password_hash)) {
          return sendJson(res, 400, { error: "当前原密码不正确" });
        }
        await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [
          hashPassword(newPassword),
          user.id,
        ]);
      }

      return sendJson(res, 200, { ok: true });
    }

    // 7. 批量快速更新资金与负债（原子事务）
    if (pathname === "/api/quick-balances" && method === "POST") {
      const body = await readJsonBody(req);
      const funds = Array.isArray(body.funds) ? body.funds : [];
      const credits = Array.isArray(body.credits) ? body.credits : [];
      const saveSnapshot = Boolean(body.saveSnapshot);

      const db = await getDb();
      const [existingFunds, existingCredits] = await Promise.all([
        db.all("SELECT id, category FROM fund_accounts WHERE user_id = ?", [user.id]),
        db.all(
          "SELECT id, category, credit_limit_cents FROM credit_accounts WHERE user_id = ?",
          [user.id]
        ),
      ]);
      const fundCatMap = new Map(existingFunds.map((f) => [Number(f.id), f.category]));
      const creditMap = new Map(existingCredits.map((c) => [Number(c.id), c]));
      const now = getNowTimestampString();
      const statements = [];

      for (const f of funds) {
        const id = Number(f.id);
        const category = fundCatMap.get(id);
        if (!category) continue;
        const bal = yuanToCents(f.balance_yuan, false);
        const hasPnl = category === "stock" || category === "fund";
        const pnl = hasPnl ? yuanToCents(f.daily_pnl_yuan, true) : 0;
        statements.push({
          sql: `UPDATE fund_accounts SET balance_cents = ?, daily_pnl_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
          params: [bal, pnl, now, id, user.id],
        });
      }

      for (const c of credits) {
        const id = Number(c.id);
        const existingCred = creditMap.get(id);
        if (!existingCred) continue;

        if (
          existingCred.category === "credit_card" &&
          c.remaining_limit_yuan !== undefined &&
          c.remaining_limit_yuan !== ""
        ) {
          const limitCents = Number(existingCred.credit_limit_cents);
          const remCents = yuanToCents(c.remaining_limit_yuan, false);
          const debtCents = Math.max(0, limitCents - remCents);
          statements.push({
            sql: `UPDATE credit_accounts SET remaining_limit_cents = ?, current_debt_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
            params: [remCents, debtCents, now, id, user.id],
          });
        } else {
          const debt = yuanToCents(c.current_debt_yuan, false);
          const rem =
            existingCred.category === "credit_card"
              ? Math.max(0, Number(existingCred.credit_limit_cents) - debt)
              : 0;
          statements.push({
            sql: `UPDATE credit_accounts SET remaining_limit_cents = ?, current_debt_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
            params: [rem, debt, now, id, user.id],
          });
        }
      }

      if (statements.length > 0) {
        await db.batch(statements);
      }

      if (saveSnapshot) {
        await captureSnapshotForDate(user, getLocalDateString(), "");
      }

      return sendJson(res, 200, { ok: true });
    }

    // 8. 信用付 / 负债账户 CRUD
    if (pathname === "/api/credit-accounts") {
      const db = await getDb();
      const now = getNowTimestampString();

      const resolveCreditAmounts = (category, body) => {
        if (category !== "credit_card") {
          return {
            creditLimitCents: 0,
            remainingLimitCents: 0,
            currentDebtCents: yuanToCents(body.current_debt_yuan, false),
          };
        }
        const rawLimit = String(body.credit_limit_yuan ?? "").trim();
        if (rawLimit === "") {
          throw new Error("请填写信用卡的授权额度");
        }
        const creditLimitCents = yuanToCents(rawLimit, false);
        const rawRem =
          body.remaining_limit_yuan !== undefined
            ? String(body.remaining_limit_yuan).trim()
            : "";

        if (rawRem !== "") {
          const remainingLimitCents = yuanToCents(rawRem, false);
          const currentDebtCents = Math.max(0, creditLimitCents - remainingLimitCents);
          return { creditLimitCents, remainingLimitCents, currentDebtCents };
        }
        if (body.current_debt_yuan !== undefined && String(body.current_debt_yuan).trim() !== "") {
          const currentDebtCents = yuanToCents(body.current_debt_yuan, false);
          const remainingLimitCents = Math.max(0, creditLimitCents - currentDebtCents);
          return { creditLimitCents, remainingLimitCents, currentDebtCents };
        }
        throw new Error("请填写信用卡的剩余额度");
      };

      if (method === "POST") {
        const body = await readJsonBody(req);
        const category = body.category;
        if (!VALID_CREDIT_CATEGORIES.includes(category)) {
          return sendJson(res, 400, { error: "无效的信用账户类型" });
        }
        const bankOrPlatform = String(body.bank_or_platform ?? "").trim();
        const cardAlias = String(body.card_alias ?? "").trim();
        if (!bankOrPlatform) {
          return sendJson(res, 400, { error: "请填写银行或平台名称" });
        }
        if (containsFullCardNumber(bankOrPlatform) || containsFullCardNumber(cardAlias)) {
          return sendJson(res, 400, {
            error: "隐私安全限制：请勿填写完整卡号（仅需记录卡片简称或后四位尾号）",
          });
        }
        const { creditLimitCents, remainingLimitCents, currentDebtCents } =
          resolveCreditAmounts(category, body);

        const inserted = await db.get(
          `INSERT INTO credit_accounts
            (user_id, category, bank_or_platform, card_alias, credit_limit_cents, remaining_limit_cents, current_debt_cents, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            user.id,
            category,
            bankOrPlatform,
            cardAlias,
            creditLimitCents,
            remainingLimitCents,
            currentDebtCents,
            now,
          ]
        );
        return sendJson(res, 200, { ok: true, id: Number(inserted.id) });
      }

      if (method === "PUT") {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { error: "缺少账户 ID" });
        const category = body.category;
        if (!VALID_CREDIT_CATEGORIES.includes(category)) {
          return sendJson(res, 400, { error: "无效的信用账户类型" });
        }
        const bankOrPlatform = String(body.bank_or_platform ?? "").trim();
        const cardAlias = String(body.card_alias ?? "").trim();
        if (!bankOrPlatform) {
          return sendJson(res, 400, { error: "请填写银行或平台名称" });
        }
        if (containsFullCardNumber(bankOrPlatform) || containsFullCardNumber(cardAlias)) {
          return sendJson(res, 400, {
            error: "隐私安全限制：请勿填写完整卡号（仅需记录卡片简称或后四位尾号）",
          });
        }
        const { creditLimitCents, remainingLimitCents, currentDebtCents } =
          resolveCreditAmounts(category, body);

        const r = await db.run(
          `UPDATE credit_accounts
           SET category = ?, bank_or_platform = ?, card_alias = ?, credit_limit_cents = ?, remaining_limit_cents = ?, current_debt_cents = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          [
            category,
            bankOrPlatform,
            cardAlias,
            creditLimitCents,
            remainingLimitCents,
            currentDebtCents,
            now,
            id,
            user.id,
          ]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "账户不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === "DELETE") {
        const id = Number(searchParams.get("id"));
        if (!id) return sendJson(res, 400, { error: "缺少账户 ID" });
        const r = await db.run(
          "DELETE FROM credit_accounts WHERE id = ? AND user_id = ?",
          [id, user.id]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "账户不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // 9. 理财 / 资金账户 CRUD
    if (pathname === "/api/fund-accounts") {
      const db = await getDb();
      const now = getNowTimestampString();

      if (method === "POST") {
        const body = await readJsonBody(req);
        const category = body.category;
        if (!VALID_FUND_CATEGORIES.includes(category)) {
          return sendJson(res, 400, { error: "无效的资金账户类型" });
        }
        const name = String(body.name ?? "").trim();
        if (!name) return sendJson(res, 400, { error: "请填写账户名称" });
        if (containsFullCardNumber(name)) {
          return sendJson(res, 400, {
            error: "隐私安全限制：请勿在名称中填写完整银行卡号",
          });
        }
        const balanceCents = yuanToCents(body.balance_yuan, false);
        const hasPnl = category === "stock" || category === "fund";
        const dailyPnlCents = hasPnl ? yuanToCents(body.daily_pnl_yuan, true) : 0;

        const inserted = await db.get(
          `INSERT INTO fund_accounts (user_id, category, name, balance_cents, daily_pnl_cents, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          [user.id, category, name, balanceCents, dailyPnlCents, now]
        );
        return sendJson(res, 200, { ok: true, id: Number(inserted.id) });
      }

      if (method === "PUT") {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { error: "缺少账户 ID" });
        const category = body.category;
        if (!VALID_FUND_CATEGORIES.includes(category)) {
          return sendJson(res, 400, { error: "无效的资金账户类型" });
        }
        const name = String(body.name ?? "").trim();
        if (!name) return sendJson(res, 400, { error: "请填写账户名称" });
        if (containsFullCardNumber(name)) {
          return sendJson(res, 400, {
            error: "隐私安全限制：请勿在名称中填写完整银行卡号",
          });
        }
        const balanceCents = yuanToCents(body.balance_yuan, false);
        const hasPnl = category === "stock" || category === "fund";
        const dailyPnlCents = hasPnl ? yuanToCents(body.daily_pnl_yuan, true) : 0;

        const r = await db.run(
          `UPDATE fund_accounts
           SET category = ?, name = ?, balance_cents = ?, daily_pnl_cents = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          [category, name, balanceCents, dailyPnlCents, now, id, user.id]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "账户不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === "DELETE") {
        const id = Number(searchParams.get("id"));
        if (!id) return sendJson(res, 400, { error: "缺少账户 ID" });
        const r = await db.run("DELETE FROM fund_accounts WHERE id = ? AND user_id = ?", [
          id,
          user.id,
        ]);
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "账户不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // 10. 薅羊毛记录 CRUD
    if (pathname === "/api/wool-records") {
      const db = await getDb();
      const now = getNowTimestampString();

      if (method === "POST") {
        const body = await readJsonBody(req);
        const recordDate = String(body.record_date ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
          return sendJson(res, 400, { error: "请选择有效的日期" });
        }
        const itemName = String(body.item_name ?? "").trim();
        if (!itemName) return sendJson(res, 400, { error: "请填写项目或物品名称" });
        const type = body.type;
        if (!VALID_WOOL_TYPES.includes(type)) {
          return sendJson(res, 400, { error: "无效的记录类型" });
        }
        const status = body.status;
        if (!VALID_WOOL_STATUSES.includes(status)) {
          return sendJson(res, 400, { error: "无效的记录状态" });
        }

        const costCents = yuanToCents(body.cost_yuan, false);
        const faceValueCents = yuanToCents(body.face_value_yuan, false);
        const actualIncomeCents =
          status === "sold" ? yuanToCents(body.actual_income_yuan, false) : 0;
        const actualPnlCents = computeWoolActualPnl(status, costCents, actualIncomeCents);
        const note = String(body.note ?? "").trim();

        const inserted = await db.get(
          `INSERT INTO wool_records
            (user_id, record_date, item_name, type, cost_cents, face_value_cents, actual_income_cents, status, actual_pnl_cents, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            user.id,
            recordDate,
            itemName,
            type,
            costCents,
            faceValueCents,
            actualIncomeCents,
            status,
            actualPnlCents,
            note,
            now,
          ]
        );
        return sendJson(res, 200, { ok: true, id: Number(inserted.id) });
      }

      if (method === "PUT") {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { error: "缺少记录 ID" });
        const recordDate = String(body.record_date ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
          return sendJson(res, 400, { error: "请选择有效的日期" });
        }
        const itemName = String(body.item_name ?? "").trim();
        if (!itemName) return sendJson(res, 400, { error: "请填写项目或物品名称" });
        const type = body.type;
        if (!VALID_WOOL_TYPES.includes(type)) {
          return sendJson(res, 400, { error: "无效的记录类型" });
        }
        const status = body.status;
        if (!VALID_WOOL_STATUSES.includes(status)) {
          return sendJson(res, 400, { error: "无效的记录状态" });
        }

        const costCents = yuanToCents(body.cost_yuan, false);
        const faceValueCents = yuanToCents(body.face_value_yuan, false);
        const actualIncomeCents =
          status === "sold" ? yuanToCents(body.actual_income_yuan, false) : 0;
        const actualPnlCents = computeWoolActualPnl(status, costCents, actualIncomeCents);
        const note = String(body.note ?? "").trim();

        const r = await db.run(
          `UPDATE wool_records
           SET record_date = ?, item_name = ?, type = ?, cost_cents = ?, face_value_cents = ?,
               actual_income_cents = ?, status = ?, actual_pnl_cents = ?, note = ?
           WHERE id = ? AND user_id = ?`,
          [
            recordDate,
            itemName,
            type,
            costCents,
            faceValueCents,
            actualIncomeCents,
            status,
            actualPnlCents,
            note,
            id,
            user.id,
          ]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "记录不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === "DELETE") {
        const id = Number(searchParams.get("id"));
        if (!id) return sendJson(res, 400, { error: "缺少记录 ID" });
        const r = await db.run("DELETE FROM wool_records WHERE id = ? AND user_id = ?", [
          id,
          user.id,
        ]);
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "记录不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // 11. 囤货管理 CRUD
    if (pathname === "/api/stockpile-items") {
      const db = await getDb();
      const now = getNowTimestampString();

      if (method === "POST") {
        const body = await readJsonBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) return sendJson(res, 400, { error: "请填写物品名称" });
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) {
          return sendJson(res, 400, { error: "请输入有效的数量（大于等于 0）" });
        }
        const unit = String(body.unit ?? "件").trim() || "件";
        const costUnitPriceCents = yuanToCents(body.cost_unit_price_yuan, false);
        const currentUnitPriceCents =
          body.current_unit_price_yuan === "" || body.current_unit_price_yuan === undefined
            ? costUnitPriceCents
            : yuanToCents(body.current_unit_price_yuan, false);
        const note = String(body.note ?? "").trim();

        const inserted = await db.get(
          `INSERT INTO stockpile_items
            (user_id, name, quantity, unit, cost_unit_price_cents, current_unit_price_cents, note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            user.id,
            name,
            quantity,
            unit,
            costUnitPriceCents,
            currentUnitPriceCents,
            note,
            now,
          ]
        );
        return sendJson(res, 200, { ok: true, id: Number(inserted.id) });
      }

      if (method === "PUT") {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { error: "缺少物品 ID" });
        const name = String(body.name ?? "").trim();
        if (!name) return sendJson(res, 400, { error: "请填写物品名称" });
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) {
          return sendJson(res, 400, { error: "请输入有效的数量（大于等于 0）" });
        }
        const unit = String(body.unit ?? "件").trim() || "件";
        const costUnitPriceCents = yuanToCents(body.cost_unit_price_yuan, false);
        const currentUnitPriceCents = yuanToCents(body.current_unit_price_yuan, false);
        const note = String(body.note ?? "").trim();

        const r = await db.run(
          `UPDATE stockpile_items
           SET name = ?, quantity = ?, unit = ?, cost_unit_price_cents = ?, current_unit_price_cents = ?, note = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          [
            name,
            quantity,
            unit,
            costUnitPriceCents,
            currentUnitPriceCents,
            note,
            now,
            id,
            user.id,
          ]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "物品不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === "DELETE") {
        const id = Number(searchParams.get("id"));
        if (!id) return sendJson(res, 400, { error: "缺少物品 ID" });
        const r = await db.run(
          "DELETE FROM stockpile_items WHERE id = ? AND user_id = ?",
          [id, user.id]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "物品不存在或无权限操作" });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // 12. 每日资产快照记录与删除
    if (pathname === "/api/snapshots") {
      if (method === "POST") {
        const body = await readJsonBody(req);
        const snapshotDate = String(body.snapshot_date || getLocalDateString()).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
          return sendJson(res, 400, { error: "无效的快照日期" });
        }
        const note = String(body.note ?? "").trim();
        await captureSnapshotForDate(user, snapshotDate, note);
        return sendJson(res, 200, { ok: true });
      }

      if (method === "DELETE") {
        const id = Number(searchParams.get("id"));
        if (!id) return sendJson(res, 400, { error: "缺少快照 ID" });
        const db = await getDb();
        const r = await db.run(
          "DELETE FROM daily_snapshots WHERE id = ? AND user_id = ?",
          [id, user.id]
        );
        if (r.changes === 0) {
          return sendJson(res, 404, { error: "快照不存在或无权限操作" });
        }
        await recomputeSnapshotChain(user.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // 13. 个人数据备份导出（JSON / CSV）
    if (pathname === "/api/export" && method === "GET") {
      const format = searchParams.get("format") || "json";
      const payload = await getDashboardPayload(user);
      const dateTag = getLocalDateString();

      if (format === "csv") {
        const lines = [];
        lines.push("# 每日资产快照");
        lines.push(
          [
            "日期",
            "当日净资产(元)",
            "较前次变化(元)",
            "对比日期",
            "资金总额(元)",
            "负债总额(元)",
            "囤货计入金额(元)",
            "囤货统计口径",
            "当日投资盈亏(元)[独立展示]",
            "当日羊毛结余(元)[独立展示]",
            "备注",
          ].join(",")
        );
        for (const s of payload.snapshots) {
          lines.push(
            [
              s.snapshot_date,
              centsToYuanString(s.net_worth_cents),
              s.net_worth_change_cents !== null
                ? centsToYuanString(s.net_worth_change_cents)
                : "",
              s.prev_snapshot_date || "",
              centsToYuanString(s.total_funds_cents),
              centsToYuanString(s.total_debt_cents),
              centsToYuanString(s.stockpile_value_cents),
              s.stockpile_mode_used === "market" ? "当前估值" : "成本价",
              centsToYuanString(s.daily_investment_pnl_cents),
              centsToYuanString(s.wool_daily_balance_cents),
              csvEscape(s.note),
            ].join(",")
          );
        }

        lines.push("");
        lines.push("# 资金与理财账户");
        lines.push(["类型", "账户名称", "当前余额(元)", "当日盈亏(元)"].join(","));
        for (const f of payload.fundAccounts) {
          lines.push(
            [
              f.category,
              csvEscape(f.name),
              centsToYuanString(f.balance_cents),
              centsToYuanString(f.daily_pnl_cents),
            ].join(",")
          );
        }

        lines.push("");
        lines.push("# 信用付与负债账户");
        lines.push(
          [
            "类型",
            "银行/平台",
            "备注",
            "授权额度(元)[仅展示]",
            "剩余额度(元)[仅展示]",
            "当前总欠款(元)",
          ].join(",")
        );
        for (const c of payload.creditAccounts) {
          lines.push(
            [
              c.category,
              csvEscape(c.bank_or_platform),
              csvEscape(c.card_alias),
              c.category === "credit_card" ? centsToYuanString(c.credit_limit_cents) : "",
              c.category === "credit_card"
                ? centsToYuanString(c.remaining_limit_cents ?? 0)
                : "",
              centsToYuanString(c.current_debt_cents),
            ].join(",")
          );
        }

        lines.push("");
        lines.push("# 薅羊毛记录（独立展示，不计入净资产）");
        lines.push(
          [
            "日期",
            "项目/物品",
            "类型",
            "状态",
            "成本(元)",
            "面值(元)",
            "实际收入(元)",
            "实际盈亏(元)",
            "备注",
          ].join(",")
        );
        for (const w of payload.woolRecords) {
          lines.push(
            [
              w.record_date,
              csvEscape(w.item_name),
              w.type,
              w.status,
              centsToYuanString(w.cost_cents),
              centsToYuanString(w.face_value_cents),
              centsToYuanString(w.actual_income_cents),
              centsToYuanString(w.actual_pnl_cents),
              csvEscape(w.note),
            ].join(",")
          );
        }

        lines.push("");
        lines.push("# 囤货清单");
        lines.push(
          [
            "物品",
            "数量",
            "单位",
            "成本单价(元)",
            "当前计价单价(元)",
            "成本总计(元)",
            "估值总计(元)",
            "备注",
          ].join(",")
        );
        for (const item of payload.stockpileItems) {
          lines.push(
            [
              csvEscape(item.name),
              item.quantity,
              csvEscape(item.unit),
              centsToYuanString(item.cost_unit_price_cents),
              centsToYuanString(item.current_unit_price_cents),
              centsToYuanString(
                Math.round(Number(item.quantity) * Number(item.cost_unit_price_cents))
              ),
              centsToYuanString(
                Math.round(
                  Number(item.quantity) * Number(item.current_unit_price_cents)
                )
              ),
              csvEscape(item.note),
            ].join(",")
          );
        }

        const csvContent = "\uFEFF" + lines.join("\r\n");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="personal-wealth-${dateTag}.csv"`,
          "Cache-Control": "no-store",
        });
        return res.end(csvContent);
      }

      const exportJson = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          username: payload.user.username,
          stockpileValuationMode: payload.user.stockpile_valuation_mode,
          fundAccounts: payload.fundAccounts,
          creditAccounts: payload.creditAccounts,
          woolRecords: payload.woolRecords,
          stockpileItems: payload.stockpileItems,
          snapshots: payload.snapshots,
        },
        null,
        2
      );
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="personal-wealth-${dateTag}.json"`,
        "Cache-Control": "no-store",
      });
      return res.end(exportJson);
    }

    return sendJson(res, 404, { error: "未找到对应的 API 接口" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "服务器处理请求时出错";
    return sendJson(res, 400, { error: message });
  }
}

export async function captureSnapshotForDate(user, snapshotDate, note) {
  const payload = await getDashboardPayload(user, snapshotDate);
  const { metrics, fundAccounts, creditAccounts } = payload;
  const detailJson = JSON.stringify({
    funds: fundAccounts.map((f) => ({
      name: f.name,
      category: f.category,
      balance_cents: f.balance_cents,
      daily_pnl_cents: f.daily_pnl_cents,
    })),
    debts: creditAccounts.map((c) => ({
      bank_or_platform: c.bank_or_platform,
      card_alias: c.card_alias,
      category: c.category,
      credit_limit_cents: c.credit_limit_cents,
      remaining_limit_cents: c.remaining_limit_cents,
      current_debt_cents: c.current_debt_cents,
    })),
  });

  const db = await getDb();
  const now = getNowTimestampString();
  await db.run(
    `INSERT INTO daily_snapshots (
      user_id, snapshot_date, total_funds_cents, total_debt_cents,
      stockpile_cost_cents, stockpile_market_cents, stockpile_value_cents, stockpile_mode_used,
      net_worth_cents, daily_investment_pnl_cents, wool_daily_balance_cents, detail_json, note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, snapshot_date) DO UPDATE SET
      total_funds_cents = excluded.total_funds_cents,
      total_debt_cents = excluded.total_debt_cents,
      stockpile_cost_cents = excluded.stockpile_cost_cents,
      stockpile_market_cents = excluded.stockpile_market_cents,
      stockpile_value_cents = excluded.stockpile_value_cents,
      stockpile_mode_used = excluded.stockpile_mode_used,
      net_worth_cents = excluded.net_worth_cents,
      daily_investment_pnl_cents = excluded.daily_investment_pnl_cents,
      wool_daily_balance_cents = excluded.wool_daily_balance_cents,
      detail_json = excluded.detail_json,
      note = CASE WHEN excluded.note != '' THEN excluded.note ELSE daily_snapshots.note END,
      updated_at = excluded.updated_at`,
    [
      user.id,
      snapshotDate,
      metrics.totalFundsCents,
      metrics.totalDebtCents,
      metrics.stockpileCostCents,
      metrics.stockpileMarketCents,
      metrics.stockpileActiveValueCents,
      metrics.valuationMode,
      metrics.netWorthCents,
      metrics.dailyInvestmentPnlCents,
      metrics.woolTodayBalanceCents,
      detailJson,
      note,
      now,
    ]
  );

  await recomputeSnapshotChain(user.id);
}
