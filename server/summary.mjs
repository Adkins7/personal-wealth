import { getDb } from "./db.mjs";
import { getLocalDateString } from "./money.mjs";

export function computeWoolActualPnl(status, costCents, actualIncomeCents) {
  if (status === "sold") {
    return actualIncomeCents - costCents;
  }
  if (status === "expired") {
    return -costCents;
  }
  // pending（未兑现/未售出）：严格区分面值与现金，未兑现时不产生实际盈亏
  return 0;
}

export function recomputeSnapshotChain(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, snapshot_date, net_worth_cents
       FROM daily_snapshots
       WHERE user_id = ?
       ORDER BY snapshot_date ASC`
    )
    .all(userId);

  const updateStmt = db.prepare(
    `UPDATE daily_snapshots
     SET net_worth_change_cents = ?, prev_snapshot_date = ?
     WHERE id = ? AND user_id = ?`
  );

  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      updateStmt.run(null, null, rows[i].id, userId);
    } else {
      const diff = rows[i].net_worth_cents - rows[i - 1].net_worth_cents;
      updateStmt.run(diff, rows[i - 1].snapshot_date, rows[i].id, userId);
    }
  }
}

export function seedDefaultAccountsForNewUser(userId) {
  const db = getDb();
  const insertCredit = db.prepare(
    `INSERT INTO credit_accounts
      (user_id, category, bank_or_platform, card_alias, credit_limit_cents, current_debt_cents, sort_order)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  );
  insertCredit.run(userId, "huabei", "花呗", "蚂蚁花呗", 10);
  insertCredit.run(userId, "baitiao", "京东白条", "京东白条", 20);

  const insertFund = db.prepare(
    `INSERT INTO fund_accounts
      (user_id, category, name, balance_cents, daily_pnl_cents, sort_order)
     VALUES (?, ?, ?, 0, 0, ?)`
  );
  insertFund.run(userId, "stock", "股票账户", 10);
  insertFund.run(userId, "fund", "支付宝基金", 20);
  insertFund.run(userId, "debit_card", "储蓄卡", 30);
  insertFund.run(userId, "wechat_pay", "微信零钱", 40);
}

export function getDashboardPayload(user, targetDate) {
  const db = getDb();
  const today = targetDate || getLocalDateString();

  // 重新读取最新用户配置（例如刚切换了囤货估值口径）
  const freshUser =
    db
      .prepare("SELECT id, username, stockpile_valuation_mode FROM users WHERE id = ?")
      .get(user.id) || user;

  const creditAccounts = db
    .prepare(
      `SELECT * FROM credit_accounts
       WHERE user_id = ?
       ORDER BY
         CASE category
           WHEN 'credit_card' THEN 1
           WHEN 'huabei' THEN 2
           WHEN 'baitiao' THEN 3
           ELSE 4
         END,
         sort_order ASC, id ASC`
    )
    .all(user.id);

  const fundAccounts = db
    .prepare(
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
         sort_order ASC, id ASC`
    )
    .all(user.id);

  const woolRecords = db
    .prepare(
      `SELECT * FROM wool_records
       WHERE user_id = ?
       ORDER BY record_date DESC, id DESC`
    )
    .all(user.id);

  const stockpileItems = db
    .prepare(
      `SELECT * FROM stockpile_items
       WHERE user_id = ?
       ORDER BY id DESC`
    )
    .all(user.id);

  const snapshots = db
    .prepare(
      `SELECT * FROM daily_snapshots
       WHERE user_id = ?
       ORDER BY snapshot_date ASC`
    )
    .all(user.id);

  // 1. 负债总额 = 所有信用卡欠款 + 花呗欠款 + 白条欠款；信用卡授权额度只展示，不计入负债或资产
  let totalDebtCents = 0;
  let totalCreditLimitCents = 0;
  for (const acc of creditAccounts) {
    totalDebtCents += Number(acc.current_debt_cents);
    if (acc.category === "credit_card") {
      totalCreditLimitCents += Number(acc.credit_limit_cents);
    }
  }

  // 2. 资金总额 = 股票余额 + 支付宝基金余额 + 储蓄卡余额 + 微信零钱余额（+其他资金账户）
  //    当日投资盈亏 = 股票当日盈亏 + 基金当日盈亏
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

  // 3. 囤货总额 = Σ(每项数量 × 计价单价)，支持按成本价或当前估值统计
  let stockpileCostCents = 0;
  let stockpileMarketCents = 0;
  for (const item of stockpileItems) {
    stockpileCostCents += Math.round(Number(item.quantity) * Number(item.cost_unit_price_cents));
    stockpileMarketCents += Math.round(
      Number(item.quantity) * Number(item.current_unit_price_cents)
    );
  }
  const valuationMode = freshUser.stockpile_valuation_mode;
  const stockpileActiveValueCents =
    valuationMode === "market" ? stockpileMarketCents : stockpileCostCents;
  const stockpileUnrealizedPnlCents = stockpileMarketCents - stockpileCostCents;

  // 4. 薅羊毛（独立展示流量结余，不计入净资产，彻底杜绝与资金账户余额重复计算）
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

  // 5. 当日净资产 = 资金总额 − 负债总额 + 囤货估值（当前选定口径）
  const netWorthCents = totalFundsCents - totalDebtCents + stockpileActiveValueCents;

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
    },
    today,
    creditAccounts,
    fundAccounts,
    woolRecords,
    stockpileItems,
    snapshots,
    metrics: {
      totalFundsCents,
      totalDebtCents,
      totalCreditLimitCents,
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
    },
  };
}
