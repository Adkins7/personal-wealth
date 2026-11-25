import { getDb } from "./db.mjs";
import { getLocalDateString, getNowTimestampString } from "./money.mjs";

export function computeWoolActualPnl(status, costCents, actualIncomeCents) {
  if (status === "sold") {
    return actualIncomeCents - costCents;
  }
  if (status === "expired") {
    return -costCents;
  }
  return 0;
}

export async function recomputeSnapshotChain(userId) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT id, snapshot_date, net_worth_cents
     FROM daily_snapshots
     WHERE user_id = ?
     ORDER BY snapshot_date ASC`,
    [userId]
  );

  if (rows.length === 0) return;

  const statements = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      statements.push({
        sql: `UPDATE daily_snapshots SET net_worth_change_cents = ?, prev_snapshot_date = ? WHERE id = ? AND user_id = ?`,
        params: [null, null, rows[i].id, userId],
      });
    } else {
      const diff = Number(rows[i].net_worth_cents) - Number(rows[i - 1].net_worth_cents);
      statements.push({
        sql: `UPDATE daily_snapshots SET net_worth_change_cents = ?, prev_snapshot_date = ? WHERE id = ? AND user_id = ?`,
        params: [diff, rows[i - 1].snapshot_date, rows[i].id, userId],
      });
    }
  }
  await db.batch(statements);
}

export async function seedDefaultAccountsForNewUser(userId) {
  const db = await getDb();
  const now = getNowTimestampString();
  await db.batch([
    {
      sql: `INSERT INTO credit_accounts
        (user_id, category, bank_or_platform, card_alias, credit_limit_cents, current_debt_cents, sort_order, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "huabei", "花呗", "蚂蚁花呗", 10, now],
    },
    {
      sql: `INSERT INTO credit_accounts
        (user_id, category, bank_or_platform, card_alias, credit_limit_cents, current_debt_cents, sort_order, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "baitiao", "京东白条", "京东白条", 20, now],
    },
    {
      sql: `INSERT INTO fund_accounts
        (user_id, category, name, balance_cents, daily_pnl_cents, sort_order, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "stock", "股票账户", 10, now],
    },
    {
      sql: `INSERT INTO fund_accounts
        (user_id, category, name, balance_cents, daily_pnl_cents, sort_order, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "fund", "支付宝基金", 20, now],
    },
    {
      sql: `INSERT INTO fund_accounts
        (user_id, category, name, balance_cents, daily_pnl_cents, sort_order, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "debit_card", "储蓄卡", 30, now],
    },
    {
      sql: `INSERT INTO fund_accounts
        (user_id, category, name, balance_cents, daily_pnl_cents, sort_order, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      params: [userId, "wechat_pay", "微信零钱", 40, now],
    },
  ]);
}

export async function getDashboardPayload(user, targetDate) {
  const db = await getDb();
  const today = targetDate || getLocalDateString();

  const freshUser =
    (await db.get(
      "SELECT id, username, stockpile_valuation_mode, monthly_budget_cents FROM users WHERE id = ?",
      [user.id]
    )) || user;

  const [
    creditAccounts,
    fundAccounts,
    woolRecords,
    stockpileItems,
    expenseRecords,
    snapshots,
  ] = await Promise.all([
    db.all(
      `SELECT * FROM credit_accounts
       WHERE user_id = ?
       ORDER BY
         CASE category
           WHEN 'credit_card' THEN 1
           WHEN 'huabei' THEN 2
           WHEN 'baitiao' THEN 3
           ELSE 4
         END,
         sort_order ASC, id ASC`,
      [user.id]
    ),
    db.all(
      `SELECT * FROM fund_accounts
       WHERE user_id = ?
       ORDER BY
         CASE category
           WHEN 'stock' THEN 1
           WHEN 'fund' THEN 2
           WHEN 'debit_card' THEN 3
           WHEN 'wechat_pay' THEN 4
           ELSE 5
         END,
         sort_order ASC, id ASC`,
      [user.id]
    ),
    db.all(
      `SELECT * FROM wool_records
       WHERE user_id = ?
       ORDER BY record_date DESC, id DESC`,
      [user.id]
    ),
    db.all(
      `SELECT * FROM stockpile_items
       WHERE user_id = ?
       ORDER BY id DESC`,
      [user.id]
    ),
    db.all(
      `SELECT * FROM daily_expenses
       WHERE user_id = ?
       ORDER BY expense_date DESC, id DESC`,
      [user.id]
    ),
    db.all(
      `SELECT * FROM daily_snapshots
       WHERE user_id = ?
       ORDER BY snapshot_date ASC`,
      [user.id]
    ),
  ]);

  let totalDebtCents = 0;
  let totalCreditLimitCents = 0;
  let totalCreditRemainingCents = 0;
  for (const acc of creditAccounts) {
    totalDebtCents += Number(acc.current_debt_cents);
    if (acc.category === "credit_card") {
      totalCreditLimitCents += Number(acc.credit_limit_cents);
      totalCreditRemainingCents += Number(acc.remaining_limit_cents ?? 0);
    }
  }

  let totalFundsCents = 0;
  let dailyInvestmentPnlCents = 0;
  let stockBalanceCents = 0;
  let stockDailyPnlCents = 0;
  let fundBalanceCents = 0;
  let fundDailyPnlCents = 0;
  let cashBalanceCents = 0;

  for (const acc of fundAccounts) {
    const bal = Number(acc.balance_cents);
    const pnl = Number(acc.daily_pnl_cents);
    totalFundsCents += bal;
    if (acc.category === "stock") {
      stockBalanceCents += bal;
      stockDailyPnlCents += pnl;
      dailyInvestmentPnlCents += pnl;
    } else if (acc.category === "fund") {
      fundBalanceCents += bal;
      fundDailyPnlCents += pnl;
      dailyInvestmentPnlCents += pnl;
    } else {
      cashBalanceCents += bal;
    }
  }

  let stockpileCostCents = 0;
  let stockpileMarketCents = 0;
  for (const item of stockpileItems) {
    stockpileCostCents += Math.round(
      Number(item.quantity) * Number(item.cost_unit_price_cents)
    );
    stockpileMarketCents += Math.round(
      Number(item.quantity) * Number(item.current_unit_price_cents)
    );
  }
  const valuationMode = freshUser.stockpile_valuation_mode;
  const stockpileActiveValueCents =
    valuationMode === "market" ? stockpileMarketCents : stockpileCostCents;
  const stockpileUnrealizedPnlCents = stockpileMarketCents - stockpileCostCents;

  let woolTodayBalanceCents = 0;
  let woolTotalRealizedPnlCents = 0;
  let woolPendingFaceValueCents = 0;
  let woolPendingCostCents = 0;

  for (const rec of woolRecords) {
    if (rec.status === "sold" || rec.status === "expired") {
      woolTotalRealizedPnlCents += Number(rec.actual_pnl_cents);
      if (rec.record_date === today) {
        woolTodayBalanceCents += Number(rec.actual_pnl_cents);
      }
    } else {
      woolPendingFaceValueCents += Number(rec.face_value_cents);
      woolPendingCostCents += Number(rec.cost_cents);
    }
  }

  const netWorthCents = totalFundsCents - totalDebtCents + stockpileActiveValueCents;

  // 每日消费（独立流量指标，不二次扣减净资产）
  const currentMonth = today.slice(0, 7);
  let expenseTodayCents = 0;
  let expenseMonthTotalCents = 0;
  let expenseMonthRegularCents = 0;

  for (const exp of expenseRecords) {
    const amt = Number(exp.amount_cents);
    if (exp.expense_date === today) {
      expenseTodayCents += amt;
    }
    if (exp.expense_date.startsWith(currentMonth)) {
      expenseMonthTotalCents += amt;
      if (!Number(exp.is_large)) {
        expenseMonthRegularCents += amt;
      }
    }
  }

  const daysElapsed = Math.max(1, Number(today.slice(8, 10)) || 1);
  const expenseMonthDailyAvgCents = Math.round(expenseMonthRegularCents / daysElapsed);
  const monthlyBudgetCents = Number(freshUser.monthly_budget_cents ?? 0);

  let prevSnapshot = null;
  let todaySnapshot = null;
  for (const snap of snapshots) {
    if (snap.snapshot_date < today) {
      prevSnapshot = snap;
    } else if (snap.snapshot_date === today) {
      todaySnapshot = snap;
    }
  }

  const netWorthChangeCents = prevSnapshot
    ? netWorthCents - Number(prevSnapshot.net_worth_cents)
    : null;
  const prevSnapshotDate = prevSnapshot ? prevSnapshot.snapshot_date : null;

  return {
    user: {
      id: Number(freshUser.id),
      username: freshUser.username,
      stockpile_valuation_mode: valuationMode,
      monthly_budget_cents: monthlyBudgetCents,
    },
    today,
    creditAccounts,
    fundAccounts,
    woolRecords,
    stockpileItems,
    expenseRecords,
    snapshots,
    metrics: {
      totalFundsCents,
      totalDebtCents,
      totalCreditLimitCents,
      totalCreditRemainingCents,
      dailyInvestmentPnlCents,
      stockBalanceCents,
      stockDailyPnlCents,
      fundBalanceCents,
      fundDailyPnlCents,
      cashBalanceCents,
      stockpileCostCents,
      stockpileMarketCents,
      stockpileActiveValueCents,
      stockpileUnrealizedPnlCents,
      valuationMode,
      netWorthCents,
      netWorthChangeCents,
      prevSnapshotDate,
      hasTodaySnapshot: Boolean(todaySnapshot),
      todaySnapshotUpdatedAt: todaySnapshot?.updated_at || null,
      woolTodayBalanceCents,
      woolTotalRealizedPnlCents,
      woolPendingFaceValueCents,
      woolPendingCostCents,
      expenseTodayCents,
      expenseMonthTotalCents,
      expenseMonthRegularCents,
      expenseMonthDailyAvgCents,
      monthlyBudgetCents,
    },
  };
}
