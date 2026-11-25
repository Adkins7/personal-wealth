import { apiFetch } from "./api.js";
import { renderNetWorthChart } from "./chart.js";
import {
  COMMON_BANKS,
  CREDIT_CATEGORY_LABELS,
  FUND_CATEGORY_LABELS,
  OTHER_CREDIT_PLATFORMS,
  WOOL_STATUS_LABELS,
  WOOL_TYPE_LABELS,
  centsToInputYuan,
  escapeHtml,
  formatMoney,
  parseYuanPreviewCents,
  pillClassForDelta,
  pnlClass,
} from "./format.js";
import { icons } from "./icons.js";

const state = {
  authChecked: false,
  authenticated: false,
  allowRegistration: true,
  hasAnyUser: false,
  authMode: "login",
  activeTab: "overview", // overview | accounts | wool | stockpile
  masked: localStorage.getItem("pw_masked") === "1",
  woolFilterDate: "", // 空字符串表示查看全部日期，否则按 YYYY-MM-DD 过滤并展示当天结余
  dashboard: null,
};

const appRoot = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");
const toastRoot = document.getElementById("toast-root");

function showToast(message, isError = false) {
  const el = document.createElement("div");
  el.className = `toast ${isError ? "error" : ""}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 2800);
}

let modalDirty = false;

function closeModal() {
  modalDirty = false;
  modalRoot.innerHTML = "";
}

function requestCloseModal() {
  if (
    modalDirty &&
    !confirm("当前填写的内容尚未保存，确定放弃修改并关闭弹窗吗？")
  ) {
    return;
  }
  closeModal();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalRoot.innerHTML) {
    requestCloseModal();
  }
});

async function bootstrap() {
  try {
    const status = await apiFetch("/api/auth/status");
    state.authChecked = true;
    state.authenticated = status.authenticated;
    state.allowRegistration = status.allowRegistration;
    state.hasAnyUser = status.hasAnyUser;
    state.authMode = status.hasAnyUser ? "login" : "register";

    if (state.authenticated) {
      await refreshDashboard();
    } else {
      render();
    }
  } catch (err) {
    appRoot.innerHTML = `<div class="boot-screen"><div class="error-box">${escapeHtml(
      err.message
    )}</div></div>`;
  }
}

async function refreshDashboard() {
  try {
    state.dashboard = await apiFetch("/api/dashboard");
    render();
  } catch (err) {
    if (err.status === 401) {
      state.authenticated = false;
      state.dashboard = null;
      render();
      return;
    }
    showToast(err.message, true);
  }
}

function render() {
  if (!state.authenticated || !state.dashboard) {
    renderAuth();
    return;
  }
  renderMainApp();
}

/* ========================= 1. 登录与注册界面 ========================= */
function renderAuth() {
  const showSwitch = state.allowRegistration && state.hasAnyUser;
  const isReg = state.authMode === "register";

  appRoot.innerHTML = `
    <div class="auth-shell">
      <div class="auth-container">
        <div class="auth-brand">
          <div class="auth-logo">${icons.shield}</div>
          <h1>Personal Ledger</h1>
          <p>${
            !state.hasAnyUser
              ? "首次启用 · 创建你的私有个人资产账本"
              : "清爽、可信、克制的个人每日财务仪表盘"
          }</p>
        </div>

        <div class="auth-card">
          ${
            showSwitch
              ? `<div class="segmented full" style="margin-bottom:20px;">
                  <button type="button" class="segmented-btn ${!isReg ? "active" : ""}" data-auth-mode="login">登录账本</button>
                  <button type="button" class="segmented-btn ${isReg ? "active" : ""}" data-auth-mode="register">注册新账号</button>
                </div>`
              : ""
          }
          <form id="auth-form" style="display:flex;flex-direction:column;gap:14px;">
            <div class="form-field">
              <label class="form-label">用户名</label>
              <input class="input" name="username" required minlength="2" maxlength="32" autocomplete="username" placeholder="请输入用户名" />
            </div>
            <div class="form-field">
              <label class="form-label">密码 ${
                isReg ? '<span class="text-subtle">(至少 8 位)</span>' : ""
              }</label>
              <input class="input" type="password" name="password" required minlength="${
                isReg ? 8 : 1
              }" autocomplete="${
    isReg ? "new-password" : "current-password"
  }" placeholder="请输入密码" />
            </div>
            ${
              isReg
                ? `<div class="form-field">
                    <label class="form-label">确认密码</label>
                    <input class="input" type="password" name="confirmPassword" required minlength="8" autocomplete="new-password" placeholder="再次输入密码" />
                  </div>`
                : ""
            }
            <div id="auth-error"></div>
            <button type="submit" class="btn btn-primary" style="width:100%;padding:10px 16px;margin-top:4px;">
              ${isReg ? "创建私有账本并进入" : "进入资产仪表盘"}
            </button>
          </form>
        </div>

        <div class="auth-footnote">
          密码采用 Scrypt 加盐哈希存储 · 会话经 HttpOnly 安全保护<br/>
          不采集网银密码、短信验证码或完整银行卡号
        </div>
      </div>
    </div>
  `;

  appRoot.querySelectorAll("[data-auth-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.authMode = btn.getAttribute("data-auth-mode");
      renderAuth();
    });
  });

  const form = document.getElementById("auth-form");
  const errBox = document.getElementById("auth-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.innerHTML = "";
    const fd = new FormData(form);
    const username = String(fd.get("username") || "").trim();
    const password = String(fd.get("password") || "");
    const confirmPassword = String(fd.get("confirmPassword") || "");

    if (isReg && password !== confirmPassword) {
      errBox.innerHTML = `<div class="error-box">两次输入的密码不一致</div>`;
      return;
    }

    try {
      await apiFetch(isReg ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: { username, password },
      });
      state.authenticated = true;
      state.hasAnyUser = true;
      await refreshDashboard();
    } catch (err) {
      errBox.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

/* ========================= 2. 主仪表盘框架 ========================= */
function renderMainApp() {
  const { user, today, metrics } = state.dashboard;

  appRoot.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand-group">
          <div class="brand-mark">${icons.ledger}</div>
          <div>
            <div class="brand-title">Personal Ledger</div>
            <div class="brand-sub num">${escapeHtml(today)} · ${escapeHtml(user.username)}</div>
          </div>
        </div>

        <nav class="segmented" aria-label="主导航">
          <button type="button" class="segmented-btn ${
            state.activeTab === "overview" ? "active" : ""
          }" data-tab="overview">总览与快照</button>
          <button type="button" class="segmented-btn ${
            state.activeTab === "accounts" ? "active" : ""
          }" data-tab="accounts">资金与负债</button>
          <button type="button" class="segmented-btn ${
            state.activeTab === "wool" ? "active" : ""
          }" data-tab="wool">薅羊毛</button>
          <button type="button" class="segmented-btn ${
            state.activeTab === "stockpile" ? "active" : ""
          }" data-tab="stockpile">囤货估值</button>
        </nav>

        <div class="topbar-actions">
          <button type="button" id="btn-toggle-mask" class="btn btn-ghost" title="${
            state.masked ? "显示真实金额" : "隐藏全站金额（防窥屏）"
          }">
            ${state.masked ? icons.eyeOff : icons.eye}
          </button>
          <button type="button" id="btn-quick-checkin" class="btn btn-secondary">
            ${icons.sliders}
            <span>快速盘点</span>
          </button>
          <button type="button" id="btn-save-snapshot" class="btn btn-primary">
            ${metrics.hasTodaySnapshot ? icons.check : icons.camera}
            <span>${metrics.hasTodaySnapshot ? "更新今日快照" : "记录今日快照"}</span>
          </button>
          <button type="button" id="btn-open-settings" class="btn btn-ghost" title="偏好设置、数据备份与账号">
            ${icons.settings}
          </button>
        </div>
      </div>
    </header>

    <main class="page-container" id="tab-content"></main>
  `;

  appRoot.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.getAttribute("data-tab");
      renderMainApp();
    });
  });

  document.getElementById("btn-toggle-mask").addEventListener("click", () => {
    state.masked = !state.masked;
    localStorage.setItem("pw_masked", state.masked ? "1" : "0");
    renderMainApp();
  });

  document.getElementById("btn-quick-checkin").addEventListener("click", () => {
    openQuickCheckinModal();
  });

  document.getElementById("btn-save-snapshot").addEventListener("click", async () => {
    try {
      await apiFetch("/api/snapshots", {
        method: "POST",
        body: { snapshot_date: today },
      });
      showToast(metrics.hasTodaySnapshot ? "已更新今日资产快照" : "已保存今日资产快照");
      await refreshDashboard();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("btn-open-settings").addEventListener("click", () => {
    openSettingsModal();
  });

  const tabContainer = document.getElementById("tab-content");
  if (state.activeTab === "overview") {
    renderOverviewTab(tabContainer);
  } else if (state.activeTab === "accounts") {
    renderAccountsTab(tabContainer);
  } else if (state.activeTab === "wool") {
    renderWoolTab(tabContainer);
  } else if (state.activeTab === "stockpile") {
    renderStockpileTab(tabContainer);
  }
}

/* ========================= 3. 总览与每日快照视图 ========================= */
function renderOverviewTab(container) {
  const { metrics, snapshots, today } = state.dashboard;
  const masked = state.masked;
  const modeLabel = metrics.valuationMode === "market" ? "当前估值" : "成本价";

  const grossPositive = Math.max(
    metrics.totalFundsCents + metrics.stockpileActiveValueCents,
    1
  );
  const fundsPct = Math.round((metrics.totalFundsCents / grossPositive) * 100);
  const stockpilePct = Math.max(0, 100 - fundsPct);

  const deltaPillHtml =
    metrics.netWorthChangeCents !== null
      ? `<span class="pill num ${pillClassForDelta(metrics.netWorthChangeCents)}">
          ${formatMoney(metrics.netWorthChangeCents, { masked, showSign: true })}
          <span>· 较 ${escapeHtml((metrics.prevSnapshotDate || "").slice(5))} 快照</span>
        </span>`
      : `<span class="pill pill-neutral">保存两日以上快照后自动对比较昨日变化</span>`;

  const reversedSnapshots = [...snapshots].reverse();

  container.innerHTML = `
    <!-- Hero 净资产主卡 -->
    <section class="card hero-card">
      <div class="hero-top">
        <div>
          <div class="hero-eyebrow">
            <span>当前净资产</span>
            <span class="pill pill-neutral pill-clickable" id="hero-toggle-mode" title="点击切换囤货计入净资产的统计口径">
              囤货按${modeLabel}计入 ${icons.swap}
            </span>
          </div>
          <div class="hero-networth num ${
            metrics.netWorthCents < 0 ? "text-loss" : ""
          }">${formatMoney(metrics.netWorthCents, { masked })}</div>
          <div class="hero-delta-row">
            ${deltaPillHtml}
            <span class="text-subtle" style="font-size:12px;">
              公式：资金总额 − 负债总额 + 囤货(${modeLabel})
            </span>
          </div>
        </div>

        <div style="text-align:right;">
          <div class="text-subtle" style="font-size:12px;">今日快照状态</div>
          <div style="margin-top:4px;font-size:13px;font-weight:500;color:${
            metrics.hasTodaySnapshot ? "var(--gain)" : "var(--muted)"
          };">
            ${metrics.hasTodaySnapshot ? "今日已归档" : "今日待归档"}
          </div>
          ${
            metrics.todaySnapshotUpdatedAt
              ? `<div class="num text-subtle" style="font-size:11.5px;margin-top:2px;">更新于 ${escapeHtml(
                  metrics.todaySnapshotUpdatedAt.slice(11, 16)
                )}</div>`
              : ""
          }
        </div>
      </div>

      <div class="ratio-bar" title="资产结构：资金账户 ${fundsPct}% / 囤货 ${stockpilePct}%">
        <div class="ratio-seg-funds" style="width:${fundsPct}%"></div>
        <div class="ratio-seg-stockpile" style="width:${stockpilePct}%"></div>
      </div>

      <div class="formula-strip">
        <div class="formula-item">
          <div class="formula-label">
            <span>资金总额</span>
            <button type="button" class="btn-ghost btn-sm" data-goto="accounts" style="padding:2px 6px;font-size:11.5px;">管理 →</button>
          </div>
          <div class="formula-value num">${formatMoney(metrics.totalFundsCents, {
            masked,
          })}</div>
          <div class="formula-meta num">
            投资 ${formatMoney(metrics.stockBalanceCents + metrics.fundBalanceCents, {
              masked,
            })} · 现金 ${formatMoney(metrics.cashBalanceCents, { masked })}
          </div>
        </div>

        <div class="formula-item">
          <div class="formula-label">
            <span>− 负债总额</span>
            <button type="button" class="btn-ghost btn-sm" data-goto="accounts" style="padding:2px 6px;font-size:11.5px;">管理 →</button>
          </div>
          <div class="formula-value num ${
            metrics.totalDebtCents > 0 ? "text-loss" : ""
          }">${
    metrics.totalDebtCents > 0
      ? "-" + formatMoney(metrics.totalDebtCents, { masked })
      : formatMoney(0, { masked })
  }</div>
          <div class="formula-meta num">
            信用卡总授信 ${formatMoney(metrics.totalCreditLimitCents, {
              masked,
            })}（仅展示，不计负债）
          </div>
        </div>

        <div class="formula-item">
          <div class="formula-label">
            <span>+ 囤货总额（${modeLabel}）</span>
            <button type="button" class="btn-ghost btn-sm" data-goto="stockpile" style="padding:2px 6px;font-size:11.5px;">切换/管理 →</button>
          </div>
          <div class="formula-value num">${formatMoney(
            metrics.stockpileActiveValueCents,
            { masked }
          )}</div>
          <div class="formula-meta num">
            账面浮盈亏 <span class="${pnlClass(
              metrics.stockpileUnrealizedPnlCents
            )}">${formatMoney(metrics.stockpileUnrealizedPnlCents, {
    masked,
    showSign: true,
  })}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 独立流量指标（严格与净资产变化区分，避免重复计算或概念混淆） -->
    <div class="flow-section-label">
      <span>今日独立流量指标 · 单独展示，不与净资产变化混同、不重复累加</span>
    </div>
    <section class="grid-2">
      <div class="card card-compact">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="text-muted" style="font-size:12.5px;font-weight:500;">当日投资盈亏（股票 + 基金）</span>
          <span class="pill pill-neutral">独立展示</span>
        </div>
        <div class="metric-big num ${pnlClass(metrics.dailyInvestmentPnlCents)}">
          ${formatMoney(metrics.dailyInvestmentPnlCents, { masked, showSign: true })}
        </div>
        <div class="metric-foot num">
          <span>股票当日：<strong class="${pnlClass(
            metrics.stockDailyPnlCents
          )}">${formatMoney(metrics.stockDailyPnlCents, {
    masked,
    showSign: true,
  })}</strong></span>
          <span>基金当日：<strong class="${pnlClass(
            metrics.fundDailyPnlCents
          )}">${formatMoney(metrics.fundDailyPnlCents, {
    masked,
    showSign: true,
  })}</strong></span>
        </div>
      </div>

      <div class="card card-compact">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="text-muted" style="font-size:12.5px;font-weight:500;">羊毛当日结余（已售出/已兑现盈亏）</span>
          <span class="pill pill-neutral">不计入净资产</span>
        </div>
        <div class="metric-big num ${pnlClass(metrics.woolTodayBalanceCents)}">
          ${formatMoney(metrics.woolTodayBalanceCents, { masked, showSign: true })}
        </div>
        <div class="metric-foot num">
          <span>累计已落袋：<strong class="${pnlClass(
            metrics.woolTotalRealizedPnlCents
          )}">${formatMoney(metrics.woolTotalRealizedPnlCents, {
    masked,
    showSign: true,
  })}</strong></span>
          <span>未兑现面值：<strong>${formatMoney(metrics.woolPendingFaceValueCents, {
            masked,
          })}</strong>（不当现金）</span>
        </div>
      </div>
    </section>

    <!-- 净资产走势图 -->
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">每日净资产趋势</h2>
          <p class="card-subtitle">鼠标悬停数据点可查看当日快照详情与对应统计口径</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-custom-snapshot">
          ${icons.plus} 指定日期归档快照
        </button>
      </div>
      <div id="chart-mount"></div>
    </section>

    <!-- 每日快照历史明细表 -->
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">每日资产快照记录</h2>
          <p class="card-subtitle">同一天多次保存将自动覆盖更新当日快照，并自动校准前后日期差额</p>
        </div>
      </div>
      ${
        reversedSnapshots.length === 0
          ? `<div class="empty-box">暂无快照记录。点击右上角「记录今日快照」生成你的第一条资产基准线。</div>`
          : `<div class="table-wrap">
              <table class="clean-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th class="right">当日净资产</th>
                    <th class="right">较前次变化</th>
                    <th class="right">资金总额</th>
                    <th class="right">负债总额</th>
                    <th class="right">囤货总额(口径)</th>
                    <th class="right">当日投资盈亏</th>
                    <th class="right">当日羊毛结余</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${reversedSnapshots
                    .map(
                      (s) => `
                    <tr>
                      <td class="num" style="font-weight:500;color:var(--ink);">
                        ${escapeHtml(s.snapshot_date)}
                        ${
                          s.snapshot_date === today
                            ? `<span class="pill pill-neutral" style="margin-left:6px;padding:1px 7px;font-size:11px;">今日</span>`
                            : ""
                        }
                      </td>
                      <td class="right num" style="font-weight:600;color:var(--ink);">
                        ${formatMoney(s.net_worth_cents, { masked })}
                      </td>
                      <td class="right num ${pnlClass(s.net_worth_change_cents)}">
                        ${
                          s.net_worth_change_cents !== null
                            ? `${formatMoney(s.net_worth_change_cents, {
                                masked,
                                showSign: true,
                              })}${
                                s.prev_snapshot_date
                                  ? `<div class="text-subtle" style="font-size:11px;">较 ${escapeHtml(
                                      s.prev_snapshot_date.slice(5)
                                    )}</div>`
                                  : ""
                              }`
                            : `<span class="text-subtle">—</span>`
                        }
                      </td>
                      <td class="right num">${formatMoney(s.total_funds_cents, { masked })}</td>
                      <td class="right num ${
                        s.total_debt_cents > 0 ? "text-loss" : ""
                      }">${formatMoney(s.total_debt_cents, { masked })}</td>
                      <td class="right num">
                        ${formatMoney(s.stockpile_value_cents, { masked })}
                        <div class="text-subtle" style="font-size:11px;">${
                          s.stockpile_mode_used === "market" ? "当前估值" : "成本价"
                        }</div>
                      </td>
                      <td class="right num ${pnlClass(s.daily_investment_pnl_cents)}">
                        ${formatMoney(s.daily_investment_pnl_cents, { masked, showSign: true })}
                      </td>
                      <td class="right num ${pnlClass(s.wool_daily_balance_cents)}">
                        ${formatMoney(s.wool_daily_balance_cents, { masked, showSign: true })}
                      </td>
                      <td class="right">
                        <button type="button" class="btn btn-danger-ghost btn-sm" data-del-snapshot="${
                          s.id
                        }" title="删除该日快照">${icons.trash}</button>
                      </td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </section>
  `;

  renderNetWorthChart(
    container.querySelector("#chart-mount"),
    snapshots,
    masked
  );

  container.querySelector("#hero-toggle-mode").addEventListener("click", async () => {
    const nextMode = metrics.valuationMode === "cost" ? "market" : "cost";
    await toggleValuationMode(nextMode);
  });

  container.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.getAttribute("data-goto");
      renderMainApp();
    });
  });

  container.querySelector("#btn-custom-snapshot").addEventListener("click", () => {
    openCustomSnapshotModal();
  });

  container.querySelectorAll("[data-del-snapshot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-snapshot");
      if (!confirm("确定删除该日期的资产快照吗？删除后相邻日期的较前日变化将自动重算。")) return;
      try {
        await apiFetch(`/api/snapshots?id=${id}`, { method: "DELETE" });
        showToast("快照已删除");
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

/* ========================= 4. 资金账户与信用负债视图 ========================= */
function renderAccountsTab(container) {
  const { fundAccounts, creditAccounts, metrics } = state.dashboard;
  const masked = state.masked;

  const creditCards = creditAccounts.filter((c) => c.category === "credit_card");
  const otherDebts = creditAccounts.filter((c) => c.category !== "credit_card");

  container.innerHTML = `
    <div class="notice-banner">
      <span>提示：所有账户均采用本地手动录入，无需联网授权，绝不索取网银密码、短信验证码或完整银行卡号。</span>
      <button type="button" class="btn btn-secondary btn-sm" id="acc-quick-btn">
        ${icons.sliders} 一键批量改余额
      </button>
    </div>

    <div class="grid-2" style="align-items:start;">
      <!-- 左栏：理财与资金账户 -->
      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">理财与资金账户</h2>
            <p class="card-subtitle">
              资金总额 <strong class="num" style="color:var(--ink);">${formatMoney(
                metrics.totalFundsCents,
                { masked }
              )}</strong>
              · 当日投资盈亏 <strong class="num ${pnlClass(
                metrics.dailyInvestmentPnlCents
              )}">${formatMoney(metrics.dailyInvestmentPnlCents, {
    masked,
    showSign: true,
  })}</strong>
            </p>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="btn-add-fund">
            ${icons.plus} 添加资金账户
          </button>
        </div>

        <div class="account-list">
          ${fundAccounts
            .map((f) => {
              const hasPnl = f.category === "stock" || f.category === "fund";
              return `
                <div class="account-row">
                  <div class="account-main">
                    <div class="account-name">
                      <span>${escapeHtml(f.name)}</span>
                      <span class="pill pill-neutral" style="padding:1px 8px;font-size:11px;">
                        ${escapeHtml(FUND_CATEGORY_LABELS[f.category] || f.category)}
                      </span>
                    </div>
                    <div class="account-sub num">更新于 ${escapeHtml(
                      (f.updated_at || "").slice(0, 16)
                    )}</div>
                  </div>
                  <div class="account-right">
                    <div>
                      <div class="account-amount num">${formatMoney(f.balance_cents, {
                        masked,
                      })}</div>
                      ${
                        hasPnl
                          ? `<div class="account-pnl num ${pnlClass(f.daily_pnl_cents)}">
                              当日 ${formatMoney(f.daily_pnl_cents, { masked, showSign: true })}
                            </div>`
                          : `<div class="account-pnl text-subtle">现金类账户</div>`
                      }
                    </div>
                    <div style="display:flex;gap:2px;">
                      <button type="button" class="btn btn-ghost btn-sm" data-edit-fund="${
                        f.id
                      }" title="修改余额与名称">${icons.edit}</button>
                      <button type="button" class="btn btn-danger-ghost btn-sm" data-del-fund="${
                        f.id
                      }" title="删除账户">${icons.trash}</button>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>

      <!-- 右栏：信用付 / 负债 -->
      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">信用付 / 负债</h2>
            <p class="card-subtitle">
              负债总额 <strong class="num ${
                metrics.totalDebtCents > 0 ? "text-loss" : ""
              }">${formatMoney(metrics.totalDebtCents, { masked })}</strong>
              · 总授信 <span class="num">${formatMoney(
                metrics.totalCreditLimitCents,
                { masked }
              )}</span>
              · 总剩余 <span class="num">${formatMoney(
                metrics.totalCreditRemainingCents ?? 0,
                { masked }
              )}</span>（仅展示）
            </p>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="btn-add-credit">
            ${icons.plus} 添加信用卡 / 负债
          </button>
        </div>

        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">
          信用卡（填授权额度与云闪付剩余额度，自动计算欠款）
        </div>
        <div class="text-subtle" style="font-size:11.5px;margin-bottom:8px;">
          提示：若同一家银行多张卡共享额度，建议合并录一条或只录主卡，避免重复计算欠款。
        </div>
        ${
          creditCards.length === 0
            ? `<div class="empty-box" style="padding:18px;margin-bottom:18px;">暂未添加信用卡，点击右上角「添加信用卡 / 负债」录入多家银行卡片。</div>`
            : `<div class="account-list" style="margin-bottom:20px;">
                ${creditCards
                  .map((c) => {
                    const remCents = Number(c.remaining_limit_cents ?? 0);
                    const overflowCents = Math.max(0, remCents - Number(c.credit_limit_cents));
                    const util =
                      c.credit_limit_cents > 0
                        ? Math.min(
                            100,
                            Math.round((c.current_debt_cents / c.credit_limit_cents) * 100)
                          )
                        : 0;
                    return `
                      <div class="account-row">
                        <div class="account-main">
                          <div class="account-name">
                            <span>${escapeHtml(c.bank_or_platform)}</span>
                            ${
                              c.card_alias
                                ? `<span class="text-muted" style="font-weight:400;font-size:13px;">· ${escapeHtml(
                                    c.card_alias
                                  )}</span>`
                                : ""
                            }
                          </div>
                          <div class="account-sub num">
                            授信 ${formatMoney(c.credit_limit_cents, { masked })}
                            · 剩余额度 <strong style="font-weight:500;color:var(--ink-secondary);">${formatMoney(
                              remCents,
                              { masked }
                            )}</strong>
                            ${c.credit_limit_cents > 0 ? `· 已用 ${util}%` : ""}
                            ${
                              overflowCents > 0
                                ? ` · 超出授信 ${formatMoney(overflowCents, { masked })}`
                                : ""
                            }
                          </div>
                          ${
                            c.credit_limit_cents > 0
                              ? `<div class="util-bar"><div class="util-fill ${
                                  util >= 80 ? "high" : ""
                                }" style="width:${util}%"></div></div>`
                              : ""
                          }
                        </div>
                        <div class="account-right">
                          <div>
                            <div class="account-amount num ${
                              c.current_debt_cents > 0 ? "text-loss" : ""
                            }">${formatMoney(c.current_debt_cents, { masked })}</div>
                            <div class="account-pnl text-subtle">当前欠款</div>
                          </div>
                          <div style="display:flex;gap:2px;">
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-credit="${
                              c.id
                            }" title="修改剩余额度或授信">${icons.edit}</button>
                            <button type="button" class="btn btn-danger-ghost btn-sm" data-del-credit="${
                              c.id
                            }" title="删除卡片">${icons.trash}</button>
                          </div>
                        </div>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
        }

        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;">
          花呗 / 白条 / 其他信用欠款
        </div>
        <div class="account-list">
          ${otherDebts
            .map(
              (c) => `
              <div class="account-row">
                <div class="account-main">
                  <div class="account-name">
                    <span>${escapeHtml(c.bank_or_platform)}</span>
                    <span class="pill pill-neutral" style="padding:1px 8px;font-size:11px;">
                      ${escapeHtml(CREDIT_CATEGORY_LABELS[c.category] || c.category)}
                    </span>
                  </div>
                  ${
                    c.card_alias && c.card_alias !== c.bank_or_platform
                      ? `<div class="account-sub">${escapeHtml(c.card_alias)}</div>`
                      : ""
                  }
                </div>
                <div class="account-right">
                  <div>
                    <div class="account-amount num ${
                      c.current_debt_cents > 0 ? "text-loss" : ""
                    }">${formatMoney(c.current_debt_cents, { masked })}</div>
                    <div class="account-pnl text-subtle">当前欠款</div>
                  </div>
                  <div style="display:flex;gap:2px;">
                    <button type="button" class="btn btn-ghost btn-sm" data-edit-credit="${
                      c.id
                    }" title="编辑欠款">${icons.edit}</button>
                    <button type="button" class="btn btn-danger-ghost btn-sm" data-del-credit="${
                      c.id
                    }" title="删除">${icons.trash}</button>
                  </div>
                </div>
              </div>`
            )
            .join("")}
        </div>
      </section>
    </div>
  `;

  container.querySelector("#acc-quick-btn").addEventListener("click", () => {
    openQuickCheckinModal();
  });

  container.querySelector("#btn-add-fund").addEventListener("click", () => {
    openFundModal();
  });
  container.querySelectorAll("[data-edit-fund]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-edit-fund"));
      const item = fundAccounts.find((x) => x.id === id);
      if (item) openFundModal(item);
    });
  });
  container.querySelectorAll("[data-del-fund]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-fund");
      if (!confirm("确定删除该资金账户吗？")) return;
      try {
        await apiFetch(`/api/fund-accounts?id=${id}`, { method: "DELETE" });
        showToast("资金账户已删除");
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelector("#btn-add-credit").addEventListener("click", () => {
    openCreditModal();
  });
  container.querySelectorAll("[data-edit-credit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-edit-credit"));
      const item = creditAccounts.find((x) => x.id === id);
      if (item) openCreditModal(item);
    });
  });
  container.querySelectorAll("[data-del-credit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-credit");
      if (!confirm("确定删除该信用/负债账户吗？")) return;
      try {
        await apiFetch(`/api/credit-accounts?id=${id}`, { method: "DELETE" });
        showToast("信用账户已删除");
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

/* ========================= 5. 薅羊毛记录视图 ========================= */
function renderWoolTab(container) {
  const { woolRecords, metrics, today } = state.dashboard;
  const masked = state.masked;
  const filterDate = state.woolFilterDate;

  // 提取最近有记录的日期供一键筛选
  const uniqueDates = [...new Set(woolRecords.map((r) => r.record_date))].slice(0, 6);

  const filtered = filterDate
    ? woolRecords.filter((r) => r.record_date === filterDate)
    : woolRecords;

  // 计算所选日期（或今日）的当天结余
  const targetDay = filterDate || today;
  let daySettledBalanceCents = 0;
  let dayPendingFaceCents = 0;
  for (const r of woolRecords) {
    if (r.record_date === targetDay) {
      if (r.status === "sold" || r.status === "expired") {
        daySettledBalanceCents += Number(r.actual_pnl_cents);
      } else {
        dayPendingFaceCents += Number(r.face_value_cents);
      }
    }
  }

  container.innerHTML = `
    <div class="notice-banner">
      <span>口径说明：优惠券/立减金未兑现前仅记录「面值」，不当作现金；已兑现/已售出的钱已进入资金账户，此处「当日结余」仅作独立流量统计，<strong>不重复计入净资产</strong>。</span>
    </div>

    <section class="grid-3">
      <div class="card card-compact">
        <div class="text-muted" style="font-size:12px;">${escapeHtml(
          targetDay
        )} 当天结余（已兑现盈亏）</div>
        <div class="metric-big num ${pnlClass(daySettledBalanceCents)}">
          ${formatMoney(daySettledBalanceCents, { masked, showSign: true })}
        </div>
        <div class="text-subtle num" style="font-size:11.5px;margin-top:4px;">
          该日待兑现面值 ${formatMoney(dayPendingFaceCents, { masked })}
        </div>
      </div>

      <div class="card card-compact">
        <div class="text-muted" style="font-size:12px;">累计已实现羊毛总盈亏</div>
        <div class="metric-big num ${pnlClass(metrics.woolTotalRealizedPnlCents)}">
          ${formatMoney(metrics.woolTotalRealizedPnlCents, { masked, showSign: true })}
        </div>
        <div class="text-subtle" style="font-size:11.5px;margin-top:4px;">
          仅统计「已售出 / 已兑现 / 已过期」记录
        </div>
      </div>

      <div class="card card-compact">
        <div class="text-muted" style="font-size:12px;">待用优惠面值（未兑现 · 不当现金）</div>
        <div class="metric-big num" style="color:var(--ink-secondary);">
          ${formatMoney(metrics.woolPendingFaceValueCents, { masked })}
        </div>
        <div class="text-subtle num" style="font-size:11.5px;margin-top:4px;">
          未售在途垫付成本 ${formatMoney(metrics.woolPendingCostCents, { masked })}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">薅羊毛账本明细</h2>
          <p class="card-subtitle">支持按天查看记录和当天结余，点击「兑现」可快速转入已售出状态</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btn-add-wool">
          ${icons.plus} 新增羊毛记录
        </button>
      </div>

      <div class="date-chip-row">
        <button type="button" class="btn ${
          filterDate === "" ? "btn-primary" : "btn-secondary"
        } btn-sm" data-wool-date="">全部日期 (${woolRecords.length})</button>
        <button type="button" class="btn ${
          filterDate === today ? "btn-primary" : "btn-secondary"
        } btn-sm" data-wool-date="${escapeHtml(today)}">今天 (${escapeHtml(
    today.slice(5)
  )})</button>
        ${uniqueDates
          .filter((d) => d !== today)
          .map(
            (d) => `
          <button type="button" class="btn ${
            filterDate === d ? "btn-primary" : "btn-secondary"
          } btn-sm num" data-wool-date="${escapeHtml(d)}">${escapeHtml(d.slice(5))}</button>`
          )
          .join("")}
        <input type="date" id="wool-date-picker" class="input input-sm num" style="width:auto;" value="${escapeHtml(
          filterDate
        )}" />
      </div>

      ${
        filtered.length === 0
          ? `<div class="empty-box">${
              filterDate ? `${escapeHtml(filterDate)} 暂无薅羊毛记录` : "暂无薅羊毛记录，点击右上角「新增羊毛记录」开始记一笔。"
            }</div>`
          : `<div class="table-wrap">
              <table class="clean-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>项目 / 物品</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th class="right">成本</th>
                    <th class="right">标称面值</th>
                    <th class="right">实际兑现收入</th>
                    <th class="right">实际盈亏</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered
                    .map((w) => {
                      const statusBadge =
                        w.status === "sold"
                          ? `<span class="pill pill-gain">已售出/已兑现</span>`
                          : w.status === "expired"
                          ? `<span class="pill pill-loss">已过期</span>`
                          : `<span class="pill pill-neutral">未兑现/未售</span>`;
                      return `
                        <tr>
                          <td class="num">${escapeHtml(w.record_date)}</td>
                          <td>
                            <div style="font-weight:500;color:var(--ink);">${escapeHtml(
                              w.item_name
                            )}</div>
                            ${
                              w.note
                                ? `<div class="text-subtle" style="font-size:11.5px;">${escapeHtml(
                                    w.note
                                  )}</div>`
                                : ""
                            }
                          </td>
                          <td>${escapeHtml(WOOL_TYPE_LABELS[w.type] || w.type)}</td>
                          <td>${statusBadge}</td>
                          <td class="right num">${formatMoney(w.cost_cents, { masked })}</td>
                          <td class="right num text-muted">
                            ${
                              w.face_value_cents > 0
                                ? formatMoney(w.face_value_cents, { masked })
                                : "—"
                            }
                          </td>
                          <td class="right num">
                            ${
                              w.status === "sold"
                                ? formatMoney(w.actual_income_cents, { masked })
                                : `<span class="text-subtle">待兑现</span>`
                            }
                          </td>
                          <td class="right num ${
                            w.status === "pending" ? "text-subtle" : pnlClass(w.actual_pnl_cents)
                          }" style="font-weight:600;">
                            ${
                              w.status === "pending"
                                ? "¥0.00 (未兑现)"
                                : formatMoney(w.actual_pnl_cents, { masked, showSign: true })
                            }
                          </td>
                          <td class="right" style="white-space:nowrap;">
                            ${
                              w.status === "pending"
                                ? `<button type="button" class="btn btn-secondary btn-sm" data-settle-wool="${w.id}" style="margin-right:4px;">兑现</button>`
                                : ""
                            }
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-wool="${
                              w.id
                            }" title="编辑">${icons.edit}</button>
                            <button type="button" class="btn btn-danger-ghost btn-sm" data-del-wool="${
                              w.id
                            }" title="删除">${icons.trash}</button>
                          </td>
                        </tr>
                      `;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </section>
  `;

  container.querySelector("#btn-add-wool").addEventListener("click", () => {
    openWoolModal(null, filterDate || today);
  });

  container.querySelectorAll("[data-wool-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.woolFilterDate = btn.getAttribute("data-wool-date") || "";
      renderMainApp();
    });
  });

  container.querySelector("#wool-date-picker").addEventListener("change", (e) => {
    state.woolFilterDate = e.target.value || "";
    renderMainApp();
  });

  container.querySelectorAll("[data-settle-wool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-settle-wool"));
      const rec = woolRecords.find((x) => x.id === id);
      if (rec) {
        openWoolModal({
          ...rec,
          status: "sold",
          actual_income_cents:
            rec.actual_income_cents > 0 ? rec.actual_income_cents : rec.face_value_cents,
        });
      }
    });
  });

  container.querySelectorAll("[data-edit-wool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-edit-wool"));
      const rec = woolRecords.find((x) => x.id === id);
      if (rec) openWoolModal(rec);
    });
  });

  container.querySelectorAll("[data-del-wool]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-wool");
      if (!confirm("确定删除这条薅羊毛记录吗？")) return;
      try {
        await apiFetch(`/api/wool-records?id=${id}`, { method: "DELETE" });
        showToast("记录已删除");
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

/* ========================= 6. 囤货管理与双口径估值视图 ========================= */
function renderStockpileTab(container) {
  const { stockpileItems, metrics } = state.dashboard;
  const masked = state.masked;
  const isMarket = metrics.valuationMode === "market";

  container.innerHTML = `
    <div class="notice-banner">
      <div>
        当前净资产统计口径：
        <strong style="color:var(--ink);">
          ${isMarket ? "按当前估值单价合计" : "按成本单价合计（默认稳健口径）"}
        </strong>
      </div>
      <div class="segmented">
        <button type="button" class="segmented-btn ${
          !isMarket ? "active" : ""
        }" data-mode="cost">按成本价统计</button>
        <button type="button" class="segmented-btn ${
          isMarket ? "active" : ""
        }" data-mode="market">按当前估值统计</button>
      </div>
    </div>

    <section class="grid-3">
      <div class="card card-compact" style="${
        !isMarket ? "border-color:var(--ink);" : ""
      }">
        <div class="text-muted" style="font-size:12px;display:flex;justify-content:space-between;">
          <span>按成本价合计</span>
          ${!isMarket ? `<span class="pill pill-neutral" style="padding:1px 7px;font-size:11px;">当前生效</span>` : ""}
        </div>
        <div class="metric-big num">${formatMoney(metrics.stockpileCostCents, {
          masked,
        })}</div>
        <div class="text-subtle" style="font-size:11.5px;margin-top:4px;">Σ (数量 × 成本单价)</div>
      </div>

      <div class="card card-compact" style="${
        isMarket ? "border-color:var(--ink);" : ""
      }">
        <div class="text-muted" style="font-size:12px;display:flex;justify-content:space-between;">
          <span>按当前估值合计</span>
          ${isMarket ? `<span class="pill pill-neutral" style="padding:1px 7px;font-size:11px;">当前生效</span>` : ""}
        </div>
        <div class="metric-big num">${formatMoney(metrics.stockpileMarketCents, {
          masked,
        })}</div>
        <div class="text-subtle" style="font-size:11.5px;margin-top:4px;">Σ (数量 × 当前计价单价)</div>
      </div>

      <div class="card card-compact">
        <div class="text-muted" style="font-size:12px;">估值账面差额（估值 − 成本）</div>
        <div class="metric-big num ${pnlClass(metrics.stockpileUnrealizedPnlCents)}">
          ${formatMoney(metrics.stockpileUnrealizedPnlCents, { masked, showSign: true })}
        </div>
        <div class="text-subtle" style="font-size:11.5px;margin-top:4px;">共 ${
          stockpileItems.length
        } 项囤货条目</div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">囤货清单</h2>
          <p class="card-subtitle">当前表格高亮列采用「${
            isMarket ? "当前估值" : "成本价"
          }」口径计入净资产</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btn-add-stockpile">
          ${icons.plus} 添加囤货物品
        </button>
      </div>

      ${
        stockpileItems.length === 0
          ? `<div class="empty-box">暂无囤货记录，点击右上角「添加囤货物品」录入你的库存与估值。</div>`
          : `<div class="table-wrap">
              <table class="clean-table">
                <thead>
                  <tr>
                    <th>物品</th>
                    <th class="right">数量</th>
                    <th class="right">成本单价</th>
                    <th class="right">当前计价单价</th>
                    <th class="right">成本小计</th>
                    <th class="right">当前估值小计</th>
                    <th>备注</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${stockpileItems
                    .map((item) => {
                      const rowCost = Math.round(
                        Number(item.quantity) * Number(item.cost_unit_price_cents)
                      );
                      const rowMarket = Math.round(
                        Number(item.quantity) * Number(item.current_unit_price_cents)
                      );
                      return `
                        <tr>
                          <td style="font-weight:500;color:var(--ink);">${escapeHtml(
                            item.name
                          )}</td>
                          <td class="right num">${escapeHtml(item.quantity)} ${escapeHtml(
                        item.unit || "件"
                      )}</td>
                          <td class="right num">${formatMoney(item.cost_unit_price_cents, {
                            masked,
                          })}</td>
                          <td class="right num">${formatMoney(item.current_unit_price_cents, {
                            masked,
                          })}</td>
                          <td class="right num" style="${
                            !isMarket ? "font-weight:600;color:var(--ink);" : ""
                          }">${formatMoney(rowCost, { masked })}</td>
                          <td class="right num" style="${
                            isMarket ? "font-weight:600;color:var(--ink);" : ""
                          }">${formatMoney(rowMarket, { masked })}</td>
                          <td class="text-muted">${escapeHtml(item.note || "—")}</td>
                          <td class="right" style="white-space:nowrap;">
                            <button type="button" class="btn btn-ghost btn-sm" data-edit-stock="${
                              item.id
                            }" title="编辑">${icons.edit}</button>
                            <button type="button" class="btn btn-danger-ghost btn-sm" data-del-stock="${
                              item.id
                            }" title="删除">${icons.trash}</button>
                          </td>
                        </tr>
                      `;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </section>
  `;

  container.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.getAttribute("data-mode");
      if (next !== metrics.valuationMode) {
        await toggleValuationMode(next);
      }
    });
  });

  container.querySelector("#btn-add-stockpile").addEventListener("click", () => {
    openStockpileModal();
  });

  container.querySelectorAll("[data-edit-stock]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-edit-stock"));
      const item = stockpileItems.find((x) => x.id === id);
      if (item) openStockpileModal(item);
    });
  });

  container.querySelectorAll("[data-del-stock]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-stock");
      if (!confirm("确定删除该囤货条目吗？")) return;
      try {
        await apiFetch(`/api/stockpile-items?id=${id}`, { method: "DELETE" });
        showToast("囤货条目已删除");
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

async function toggleValuationMode(mode) {
  try {
    await apiFetch("/api/settings", {
      method: "PATCH",
      body: { stockpile_valuation_mode: mode },
    });
    showToast(`囤货口径已切换为：${mode === "market" ? "当前估值" : "成本价"}`);
    await refreshDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ========================= 7. 各类模态框弹窗 ========================= */

// 7.1 每日快速盘点弹窗（一屏更新全部余额、盈亏与欠款）
function openQuickCheckinModal() {
  const { fundAccounts, creditAccounts } = state.dashboard;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel wide">
        <div class="modal-header">
          <h3 class="modal-title">每日快速盘点</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="quick-form">
          <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;">
            资金与理财账户（单位：元）
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
            ${fundAccounts
              .map((f) => {
                const hasPnl = f.category === "stock" || f.category === "fund";
                return `
                  <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px;align-items:center;">
                    <div style="font-size:13px;font-weight:500;">
                      ${escapeHtml(f.name)}
                      <span class="text-subtle" style="font-size:11.5px;font-weight:400;">(${escapeHtml(
                        FUND_CATEGORY_LABELS[f.category]
                      )})</span>
                    </div>
                    <div>
                      <input class="input input-sm num" data-qfund-bal="${
                        f.id
                      }" value="${centsToInputYuan(f.balance_cents)}" placeholder="当前余额" />
                    </div>
                    <div>
                      ${
                        hasPnl
                          ? `<input class="input input-sm num" data-qfund-pnl="${
                              f.id
                            }" value="${centsToInputYuan(
                              f.daily_pnl_cents
                            )}" placeholder="当日盈亏(可正负)" />`
                          : `<span class="text-subtle" style="font-size:12px;padding-left:6px;">无当日盈亏</span>`
                      }
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>

          <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;">
            信用付 / 负债（信用卡填云闪付剩余额度，花呗/白条填当前欠款 · 单位：元）
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
            ${creditAccounts
              .map((c) => {
                const isCard = c.category === "credit_card";
                return `
                <div style="display:grid;grid-template-columns:1.25fr 0.95fr 1.1fr;gap:10px;align-items:center;">
                  <div style="font-size:13px;font-weight:500;">
                    ${escapeHtml(c.bank_or_platform)}
                    ${
                      c.card_alias && c.card_alias !== c.bank_or_platform
                        ? `<span class="text-subtle" style="font-size:11.5px;font-weight:400;">· ${escapeHtml(
                            c.card_alias
                          )}</span>`
                        : ""
                    }
                    <span class="pill pill-neutral" style="padding:1px 6px;font-size:10.5px;margin-left:4px;">
                      ${isCard ? "填剩余额度" : "填欠款"}
                    </span>
                  </div>
                  <div>
                    ${
                      isCard
                        ? `<input class="input input-sm num" data-qcredit-rem="${
                            c.id
                          }" data-qcredit-limit="${
                            c.credit_limit_cents
                          }" value="${centsToInputYuan(
                            c.remaining_limit_cents
                          )}" placeholder="剩余可用额度" />`
                        : `<input class="input input-sm num" data-qcredit-debt="${
                            c.id
                          }" value="${centsToInputYuan(
                            c.current_debt_cents
                          )}" placeholder="当前欠款" />`
                    }
                  </div>
                  <div class="text-subtle num" style="font-size:12px;padding-left:4px;" data-qcredit-preview="${
                    c.id
                  }">
                    ${
                      isCard
                        ? `授信 ${formatMoney(c.credit_limit_cents)} → 欠款 <strong class="${
                            c.current_debt_cents > 0 ? "text-loss" : ""
                          }">${formatMoney(c.current_debt_cents)}</strong>`
                        : "直接计入欠款"
                    }
                  </div>
                </div>`;
              })
              .join("")}
          </div>

          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-secondary);cursor:pointer;">
            <input type="checkbox" id="quick-save-snap" checked />
            <span>保存余额的同时，自动生成/更新「今日资产快照」</span>
          </label>

          <div id="modal-err" style="margin-top:10px;"></div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存全部更新</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();

  modalRoot.querySelectorAll("[data-qcredit-rem]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const id = inp.getAttribute("data-qcredit-rem");
      const limitCents = Number(inp.getAttribute("data-qcredit-limit") || 0);
      const remCents = parseYuanPreviewCents(inp.value);
      const previewEl = modalRoot.querySelector(`[data-qcredit-preview="${id}"]`);
      if (!previewEl) return;
      if (remCents === null) {
        previewEl.innerHTML = `授信 ${formatMoney(limitCents)} → 请输入剩余额度`;
        return;
      }
      const debtCents = Math.max(0, limitCents - remCents);
      previewEl.innerHTML = `授信 ${formatMoney(limitCents)} → 欠款 <strong class="${
        debtCents > 0 ? "text-loss" : ""
      }">${formatMoney(debtCents)}</strong>`;
    });
  });

  document.getElementById("quick-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";

    const funds = fundAccounts.map((f) => {
      const balInput = modalRoot.querySelector(`[data-qfund-bal="${f.id}"]`);
      const pnlInput = modalRoot.querySelector(`[data-qfund-pnl="${f.id}"]`);
      return {
        id: f.id,
        balance_yuan: balInput ? balInput.value : "0",
        daily_pnl_yuan: pnlInput ? pnlInput.value : "0",
      };
    });

    const credits = creditAccounts.map((c) => {
      if (c.category === "credit_card") {
        const remInput = modalRoot.querySelector(`[data-qcredit-rem="${c.id}"]`);
        return {
          id: c.id,
          remaining_limit_yuan: remInput ? remInput.value : "0",
        };
      }
      const debtInput = modalRoot.querySelector(`[data-qcredit-debt="${c.id}"]`);
      return {
        id: c.id,
        current_debt_yuan: debtInput ? debtInput.value : "0",
      };
    });

    const saveSnapshot = document.getElementById("quick-save-snap").checked;

    try {
      await apiFetch("/api/quick-balances", {
        method: "POST",
        body: { funds, credits, saveSnapshot },
      });
      closeModal();
      showToast(saveSnapshot ? "账户余额与今日快照已同步更新" : "账户余额已更新");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.2 资金账户弹窗
function openFundModal(existing = null) {
  const isEdit = Boolean(existing);
  const cat = existing?.category || "debit_card";
  const debitOptions = COMMON_BANKS.map((b) => `${b}储蓄卡`);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? "编辑资金/理财账户" : "添加资金/理财账户"}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="fund-form" class="form-grid">
          <div class="form-field">
            <label class="form-label">账户类型</label>
            <select class="select" name="category" id="fund-cat-select">
              <option value="stock" ${cat === "stock" ? "selected" : ""}>股票账户</option>
              <option value="fund" ${cat === "fund" ? "selected" : ""}>支付宝基金 / 基金</option>
              <option value="debit_card" ${cat === "debit_card" ? "selected" : ""}>储蓄卡</option>
              <option value="wechat_pay" ${cat === "wechat_pay" ? "selected" : ""}>微信零钱</option>
              <option value="other" ${cat === "other" ? "selected" : ""}>其他现金账户</option>
            </select>
          </div>
          <div class="form-field" id="fund-bank-select-wrap">
            <label class="form-label">选择储蓄卡银行</label>
            <select class="select" id="fund-bank-select">
              ${debitOptions
                .map(
                  (opt) =>
                    `<option value="${escapeHtml(opt)}" ${
                      existing?.name === opt ? "selected" : ""
                    }>${escapeHtml(opt)}</option>`
                )
                .join("")}
              <option value="__custom__" ${
                existing?.name && !debitOptions.includes(existing.name) ? "selected" : ""
              }>其他银行 / 自定义名称…</option>
            </select>
          </div>
          <div class="form-field" id="fund-name-input-wrap">
            <label class="form-label">账户名称</label>
            <input class="input" id="fund-name-input" value="${escapeHtml(
              existing?.name || ""
            )}" placeholder="如：华泰证券、招行工资卡" />
          </div>
          <div class="form-field">
            <label class="form-label">当前余额（元）</label>
            <input class="input num" name="balance_yuan" required value="${
              existing ? centsToInputYuan(existing.balance_cents) : "0"
            }" placeholder="0.00" />
          </div>
          <div class="form-field" id="fund-pnl-wrap">
            <label class="form-label">当日盈亏（元，支持正负）</label>
            <input class="input num" name="daily_pnl_yuan" value="${
              existing ? centsToInputYuan(existing.daily_pnl_cents) : "0"
            }" placeholder="如 320.50 或 -150" />
          </div>
          <div id="modal-err" class="form-field full"></div>
          <div class="modal-footer" style="margin-top:6px;">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存账户</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();
  const catSelect = document.getElementById("fund-cat-select");
  const bankSelectWrap = document.getElementById("fund-bank-select-wrap");
  const bankSelect = document.getElementById("fund-bank-select");
  const nameInputWrap = document.getElementById("fund-name-input-wrap");
  const nameInput = document.getElementById("fund-name-input");
  const pnlWrap = document.getElementById("fund-pnl-wrap");

  function syncFundFields() {
    const v = catSelect.value;
    pnlWrap.style.display = v === "stock" || v === "fund" ? "flex" : "none";
    if (v === "debit_card") {
      bankSelectWrap.style.display = "flex";
      const isCustom = bankSelect.value === "__custom__";
      nameInputWrap.style.display = isCustom ? "flex" : "none";
      nameInputWrap.className = isCustom ? "form-field full" : "form-field";
    } else {
      bankSelectWrap.style.display = "none";
      nameInputWrap.style.display = "flex";
      nameInputWrap.className = "form-field";
    }
  }
  syncFundFields();
  catSelect.addEventListener("change", syncFundFields);
  bankSelect.addEventListener("change", syncFundFields);

  document.getElementById("fund-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";

    const selectedCat = catSelect.value;
    const finalName =
      selectedCat === "debit_card" && bankSelect.value !== "__custom__"
        ? bankSelect.value
        : nameInput.value.trim();

    if (!finalName) {
      errEl.innerHTML = `<div class="error-box">请填写账户名称</div>`;
      return;
    }

    try {
      await apiFetch("/api/fund-accounts", {
        method: isEdit ? "PUT" : "POST",
        body: {
          id: existing?.id,
          category: selectedCat,
          name: finalName,
          balance_yuan: fd.get("balance_yuan"),
          daily_pnl_yuan: fd.get("daily_pnl_yuan"),
        },
      });
      closeModal();
      showToast(isEdit ? "资金账户已更新" : "已添加资金账户");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.3 信用卡与信用负债弹窗
function openCreditModal(existing = null) {
  const isEdit = Boolean(existing);
  const cat = existing?.category || "credit_card";

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? "编辑信用/负债账户" : "添加信用卡或负债"}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="credit-form" class="form-grid">
          <div class="form-field">
            <label class="form-label">负债类型</label>
            <select class="select" name="category" id="credit-cat-select">
              <option value="credit_card" ${cat === "credit_card" ? "selected" : ""}>银行信用卡</option>
              <option value="huabei" ${cat === "huabei" ? "selected" : ""}>花呗</option>
              <option value="baitiao" ${cat === "baitiao" ? "selected" : ""}>京东白条</option>
              <option value="other" ${cat === "other" ? "selected" : ""}>其他信用负债</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" id="credit-bank-label">选择发卡银行</label>
            <select class="select" id="credit-bank-select"></select>
          </div>
          <div class="form-field full" id="credit-custom-bank-wrap" style="display:none;">
            <label class="form-label">自定义银行或平台名称</label>
            <input class="input" id="credit-custom-bank-input" value="${escapeHtml(
              existing?.bank_or_platform || ""
            )}" placeholder="请输入银行或平台名称" />
          </div>
          <div class="form-field full">
            <label class="form-label">卡片备注（请勿填写完整卡号）</label>
            <input class="input" name="card_alias" value="${escapeHtml(
              existing?.card_alias || ""
            )}" placeholder="如：经典白 · 尾号8821" />
            <span class="form-hint">安全红线：请勿录入完整银行卡号、CVV、密码或验证码。</span>
          </div>
          <div class="form-field" id="credit-limit-wrap">
            <label class="form-label">授权额度（元，仅展示）</label>
            <input class="input num" id="credit-limit-input" name="credit_limit_yuan" value="${
              existing ? centsToInputYuan(existing.credit_limit_cents) : ""
            }" placeholder="如 50000" />
            <span class="form-hint">卡片固定总额度，不计入负债或资产</span>
          </div>
          <div class="form-field" id="credit-remaining-wrap">
            <label class="form-label">剩余额度（元，云闪付可用额度）</label>
            <input class="input num" id="credit-remaining-input" name="remaining_limit_yuan" value="${
              existing ? centsToInputYuan(existing.remaining_limit_cents) : ""
            }" placeholder="如 46500" />
            <span class="form-hint">系统将按「授权额度 − 剩余额度」自动算出欠款</span>
          </div>
          <div class="form-field full" id="credit-calc-preview" style="padding:10px 13px;border-radius:10px;background:var(--surface-subtle);border:1px solid var(--border);font-size:12.5px;"></div>
          <div class="form-field full" id="credit-debt-wrap" style="display:none;">
            <label class="form-label">当前欠款（元）</label>
            <input class="input num" id="credit-debt-input" name="current_debt_yuan" value="${
              existing ? centsToInputYuan(existing.current_debt_cents) : "0"
            }" placeholder="0.00" />
          </div>
          <div id="modal-err" class="form-field full"></div>
          <div class="modal-footer" style="margin-top:6px;">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存负债账户</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();
  const catSelect = document.getElementById("credit-cat-select");
  const bankLabel = document.getElementById("credit-bank-label");
  const bankSelect = document.getElementById("credit-bank-select");
  const customWrap = document.getElementById("credit-custom-bank-wrap");
  const customInput = document.getElementById("credit-custom-bank-input");
  const limitWrap = document.getElementById("credit-limit-wrap");
  const limitInput = document.getElementById("credit-limit-input");
  const remainingWrap = document.getElementById("credit-remaining-wrap");
  const remainingInput = document.getElementById("credit-remaining-input");
  const calcPreview = document.getElementById("credit-calc-preview");
  const debtWrap = document.getElementById("credit-debt-wrap");

  function updateDebtPreview() {
    if (catSelect.value !== "credit_card") return;
    const lim = parseYuanPreviewCents(limitInput.value);
    const rem = parseYuanPreviewCents(remainingInput.value);
    if (lim === null || rem === null) {
      calcPreview.innerHTML = `<span class="text-muted">填写「授权额度」与「剩余额度」后，此处自动计算并展示当前欠款</span>`;
      return;
    }
    const debt = Math.max(0, lim - rem);
    const overflow = Math.max(0, rem - lim);
    if (overflow > 0) {
      calcPreview.innerHTML = `自动算得当前欠款：<strong class="num">¥0.00</strong> <span class="text-muted num">（剩余额度超出授信 ${formatMoney(
        overflow
      )}，按 0 欠款计入）</span>`;
    } else {
      calcPreview.innerHTML = `自动算得当前欠款：<strong class="num ${
        debt > 0 ? "text-loss" : ""
      }">${formatMoney(debt)}</strong> <span class="text-subtle num">（= 授权额度 ${formatMoney(
        lim
      )} − 剩余额度 ${formatMoney(rem)}）</span>`;
    }
  }

  function populateBankOptions(isInitial = false) {
    const v = catSelect.value;
    const isCard = v === "credit_card";
    limitWrap.style.display = isCard ? "flex" : "none";
    remainingWrap.style.display = isCard ? "flex" : "none";
    calcPreview.style.display = isCard ? "block" : "none";
    debtWrap.style.display = isCard ? "none" : "flex";
    limitInput.required = isCard;
    remainingInput.required = isCard;

    let presets = [];
    if (v === "credit_card") {
      bankLabel.textContent = "选择发卡银行";
      presets = COMMON_BANKS;
    } else if (v === "huabei") {
      bankLabel.textContent = "平台名称";
      presets = ["花呗"];
    } else if (v === "baitiao") {
      bankLabel.textContent = "平台名称";
      presets = ["京东白条"];
    } else {
      bankLabel.textContent = "选择信用平台";
      presets = OTHER_CREDIT_PLATFORMS;
    }

    const currentVal = isInitial ? existing?.bank_or_platform || "" : "";
    const inPresets = !currentVal || presets.includes(currentVal);

    bankSelect.innerHTML =
      presets
        .map(
          (item) =>
            `<option value="${escapeHtml(item)}" ${
              currentVal === item ? "selected" : ""
            }>${escapeHtml(item)}</option>`
        )
        .join("") +
      `<option value="__custom__" ${!inPresets ? "selected" : ""}>${
        v === "credit_card" ? "其他银行（手动输入）…" : "其他平台（手动输入）…"
      }</option>`;

    syncCustomInput();
    updateDebtPreview();
  }

  function syncCustomInput() {
    const isCustom = bankSelect.value === "__custom__";
    customWrap.style.display = isCustom ? "flex" : "none";
    if (isCustom && !customInput.value) {
      customInput.focus();
    }
  }

  populateBankOptions(true);
  catSelect.addEventListener("change", () => {
    customInput.value = "";
    populateBankOptions(false);
  });
  bankSelect.addEventListener("change", syncCustomInput);
  limitInput.addEventListener("input", updateDebtPreview);
  remainingInput.addEventListener("input", updateDebtPreview);

  document.getElementById("credit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";

    const finalBank =
      bankSelect.value === "__custom__" ? customInput.value.trim() : bankSelect.value;
    if (!finalBank) {
      errEl.innerHTML = `<div class="error-box">请选择或填写银行/平台名称</div>`;
      return;
    }

    const selectedCat = catSelect.value;
    const payloadBody = {
      id: existing?.id,
      category: selectedCat,
      bank_or_platform: finalBank,
      card_alias: fd.get("card_alias"),
    };

    if (selectedCat === "credit_card") {
      payloadBody.credit_limit_yuan = fd.get("credit_limit_yuan");
      payloadBody.remaining_limit_yuan = fd.get("remaining_limit_yuan");
    } else {
      payloadBody.current_debt_yuan = fd.get("current_debt_yuan");
    }

    try {
      await apiFetch("/api/credit-accounts", {
        method: isEdit ? "PUT" : "POST",
        body: payloadBody,
      });
      closeModal();
      showToast(isEdit ? "信用账户已更新" : "已添加信用账户");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.4 薅羊毛记录弹窗
function openWoolModal(existing = null, defaultDate = "") {
  const isEdit = Boolean(existing?.id);
  const type = existing?.type || "instant_discount";
  const status = existing?.status || "pending";
  const dateVal = existing?.record_date || defaultDate || state.dashboard.today;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? "编辑薅羊毛记录" : "新增薅羊毛记录"}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="wool-form" class="form-grid">
          <div class="form-field">
            <label class="form-label">日期</label>
            <input type="date" class="input num" name="record_date" required value="${escapeHtml(
              dateVal
            )}" />
          </div>
          <div class="form-field">
            <label class="form-label">类型</label>
            <select class="select" name="type">
              <option value="instant_discount" ${
                type === "instant_discount" ? "selected" : ""
              }>微信/银行立减金</option>
              <option value="coupon" ${type === "coupon" ? "selected" : ""}>优惠券/消费券</option>
              <option value="resale" ${type === "resale" ? "selected" : ""}>买卖转售套利</option>
              <option value="cashback" ${type === "cashback" ? "selected" : ""}>返现/红包</option>
              <option value="other" ${type === "other" ? "selected" : ""}>其他羊毛</option>
            </select>
          </div>
          <div class="form-field full">
            <label class="form-label">项目 / 物品名称</label>
            <input class="input" name="item_name" required value="${escapeHtml(
              existing?.item_name || ""
            )}" placeholder="如：工行微信立减金 10 元、茅台冰淇淋转卖" />
          </div>
          <div class="form-field">
            <label class="form-label">实际现金成本（元）</label>
            <input class="input num" name="cost_yuan" value="${
              existing ? centsToInputYuan(existing.cost_cents) : "0"
            }" placeholder="0.00" />
          </div>
          <div class="form-field">
            <label class="form-label">优惠券/立减金面值（元）</label>
            <input class="input num" name="face_value_yuan" value="${
              existing ? centsToInputYuan(existing.face_value_cents) : "0"
            }" placeholder="标称面值，未兑现不当现金" />
          </div>
          <div class="form-field">
            <label class="form-label">当前状态</label>
            <select class="select" name="status" id="wool-status-select">
              <option value="pending" ${
                status === "pending" ? "selected" : ""
              }>未售出 / 未兑现</option>
              <option value="sold" ${
                status === "sold" ? "selected" : ""
              }>已售出 / 已兑现</option>
              <option value="expired" ${
                status === "expired" ? "selected" : ""
              }>已过期 / 作废</option>
            </select>
          </div>
          <div class="form-field" id="wool-income-wrap">
            <label class="form-label">实际变现收入/抵扣额（元）</label>
            <input class="input num" name="actual_income_yuan" value="${
              existing ? centsToInputYuan(existing.actual_income_cents) : "0"
            }" placeholder="已落袋/实际兑现价值" />
          </div>
          <div class="form-field full">
            <label class="form-label">备注（可选）</label>
            <input class="input" name="note" value="${escapeHtml(
              existing?.note || ""
            )}" placeholder="如：满50可用，闲鱼已回款" />
          </div>
          <div id="modal-err" class="form-field full"></div>
          <div class="modal-footer form-field full" style="margin-top:6px;">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存记录</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();
  const statusSelect = document.getElementById("wool-status-select");
  const incomeWrap = document.getElementById("wool-income-wrap");
  function syncIncomeVisibility() {
    incomeWrap.style.display = statusSelect.value === "sold" ? "flex" : "none";
  }
  syncIncomeVisibility();
  statusSelect.addEventListener("change", syncIncomeVisibility);

  document.getElementById("wool-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";
    try {
      await apiFetch("/api/wool-records", {
        method: isEdit ? "PUT" : "POST",
        body: {
          id: existing?.id,
          record_date: fd.get("record_date"),
          type: fd.get("type"),
          item_name: fd.get("item_name"),
          cost_yuan: fd.get("cost_yuan"),
          face_value_yuan: fd.get("face_value_yuan"),
          status: fd.get("status"),
          actual_income_yuan: fd.get("actual_income_yuan"),
          note: fd.get("note"),
        },
      });
      closeModal();
      showToast(isEdit ? "羊毛记录已更新" : "已添加羊毛记录");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.5 囤货物品弹窗
function openStockpileModal(existing = null) {
  const isEdit = Boolean(existing);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? "编辑囤货物品" : "添加囤货物品"}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="stockpile-form" class="form-grid">
          <div class="form-field full">
            <label class="form-label">物品名称</label>
            <input class="input" name="name" required value="${escapeHtml(
              existing?.name || ""
            )}" placeholder="如：猫粮、金条、护肤品、纸巾" />
          </div>
          <div class="form-field">
            <label class="form-label">数量</label>
            <input type="number" step="any" min="0" class="input num" name="quantity" required value="${
              existing ? existing.quantity : 1
            }" />
          </div>
          <div class="form-field">
            <label class="form-label">单位</label>
            <input class="input" name="unit" value="${escapeHtml(
              existing?.unit || "件"
            )}" placeholder="件 / 盒 / 克 / 瓶" />
          </div>
          <div class="form-field">
            <label class="form-label">成本单价（元）</label>
            <input class="input num" name="cost_unit_price_yuan" required value="${
              existing ? centsToInputYuan(existing.cost_unit_price_cents) : "0"
            }" placeholder="买入单价" />
          </div>
          <div class="form-field">
            <label class="form-label">当前计价单价（元）</label>
            <input class="input num" name="current_unit_price_yuan" value="${
              existing ? centsToInputYuan(existing.current_unit_price_cents) : ""
            }" placeholder="留空默认等于成本单价" />
          </div>
          <div class="form-field full">
            <label class="form-label">备注（可选）</label>
            <input class="input" name="note" value="${escapeHtml(
              existing?.note || ""
            )}" placeholder="保质期、存放位置或买入渠道" />
          </div>
          <div id="modal-err" class="form-field full"></div>
          <div class="modal-footer form-field full" style="margin-top:6px;">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存囤货</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();
  document.getElementById("stockpile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";
    try {
      await apiFetch("/api/stockpile-items", {
        method: isEdit ? "PUT" : "POST",
        body: {
          id: existing?.id,
          name: fd.get("name"),
          quantity: fd.get("quantity"),
          unit: fd.get("unit"),
          cost_unit_price_yuan: fd.get("cost_unit_price_yuan"),
          current_unit_price_yuan: fd.get("current_unit_price_yuan"),
          note: fd.get("note"),
        },
      });
      closeModal();
      showToast(isEdit ? "囤货已更新" : "已添加囤货条目");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.6 指定日期快照弹窗
function openCustomSnapshotModal() {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">归档指定日期快照</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>
        <form id="snap-form" style="display:flex;flex-direction:column;gap:14px;">
          <div class="form-field">
            <label class="form-label">快照日期</label>
            <input type="date" class="input num" name="snapshot_date" required value="${escapeHtml(
              state.dashboard.today
            )}" />
            <span class="form-hint">将以当前各账户余额、负债与囤货口径保存至所选日期（若该日已有记录则覆盖更新）。</span>
          </div>
          <div class="form-field">
            <label class="form-label">快照备注（可选）</label>
            <input class="input" name="note" placeholder="如：发薪日、月度盘点" />
          </div>
          <div id="modal-err"></div>
          <div class="modal-footer" style="margin-top:4px;">
            <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
            <button type="submit" class="btn btn-primary">保存快照</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindModalDismiss();
  document.getElementById("snap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("modal-err");
    errEl.innerHTML = "";
    try {
      await apiFetch("/api/snapshots", {
        method: "POST",
        body: {
          snapshot_date: fd.get("snapshot_date"),
          note: fd.get("note"),
        },
      });
      closeModal();
      showToast("资产快照已保存");
      await refreshDashboard();
    } catch (err) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });
}

// 7.7 设置、数据备份导出与账号安全弹窗
function openSettingsModal() {
  const { user, metrics } = state.dashboard;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal-panel">
        <div class="modal-header">
          <h3 class="modal-title">设置、备份与隐私安全</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close">${icons.close}</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:20px;">
          <!-- 估值口径 -->
          <div style="padding-bottom:16px;border-bottom:1px solid var(--border);">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;">囤货计入净资产口径</div>
            <div class="segmented full">
              <button type="button" class="segmented-btn ${
                metrics.valuationMode === "cost" ? "active" : ""
              }" data-set-mode="cost">成本价口径（默认稳健）</button>
              <button type="button" class="segmented-btn ${
                metrics.valuationMode === "market" ? "active" : ""
              }" data-set-mode="market">当前估值口径</button>
            </div>
          </div>

          <!-- 数据导出备份 -->
          <div style="padding-bottom:16px;border-bottom:1px solid var(--border);">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px;">个人数据导出与备份</div>
            <p class="text-muted" style="margin:0 0 10px;font-size:12px;">
              定期下载 JSON 或 CSV 备份，或直接备份服务端 <code>data/wealth.db</code> SQLite 文件。
            </p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a href="/api/export?format=json" class="btn btn-secondary btn-sm" style="text-decoration:none;">
                ${icons.download} 导出全量 JSON 备份
              </a>
              <a href="/api/export?format=csv" class="btn btn-secondary btn-sm" style="text-decoration:none;">
                ${icons.download} 导出 Excel 友好 CSV
              </a>
            </div>
          </div>

          <!-- 修改登录密码 -->
          <form id="pwd-form" style="padding-bottom:16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:10px;">
            <div style="font-size:13px;font-weight:600;">修改密码（当前账号：${escapeHtml(
              user.username
            )}）</div>
            <div class="form-grid">
              <input type="password" class="input input-sm" name="currentPassword" required placeholder="原密码" autocomplete="current-password" />
              <input type="password" class="input input-sm" name="newPassword" required minlength="8" placeholder="新密码（至少8位）" autocomplete="new-password" />
            </div>
            <div id="pwd-msg"></div>
            <div>
              <button type="submit" class="btn btn-secondary btn-sm">更新密码</button>
            </div>
          </form>

          <!-- 退出登录 -->
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span class="text-subtle" style="font-size:12px;">关闭公开注册可在 <code>.env</code> 设置 <code>ALLOW_REGISTRATION=false</code></span>
            <button type="button" class="btn btn-danger-ghost btn-sm" id="btn-logout" style="color:var(--loss);">退出登录</button>
          </div>
        </div>
      </div>
    </div>
  `;

  bindModalDismiss();

  modalRoot.querySelectorAll("[data-set-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const m = btn.getAttribute("data-set-mode");
      await toggleValuationMode(m);
      closeModal();
    });
  });

  document.getElementById("pwd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msgEl = document.getElementById("pwd-msg");
    msgEl.innerHTML = "";
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: {
          currentPassword: fd.get("currentPassword"),
          newPassword: fd.get("newPassword"),
        },
      });
      e.target.reset();
      modalDirty = false;
      showToast("登录密码已更新");
    } catch (err) {
      msgEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    closeModal();
    state.authenticated = false;
    state.dashboard = null;
    render();
  });
}

function bindModalDismiss() {
  modalDirty = false;
  const bg = document.getElementById("modal-bg");
  const panel = modalRoot.querySelector(".modal-panel");
  const closeBtn = document.getElementById("modal-close");
  const cancelBtn = document.getElementById("modal-cancel");

  if (panel) {
    const markDirty = () => {
      modalDirty = true;
    };
    panel.addEventListener("input", markDirty);
    panel.addEventListener("change", markDirty);
  }

  // 点击遮罩空白处不关闭弹窗，避免误触或拖选数字松手在框外导致录入数据丢失
  if (bg && panel) {
    bg.addEventListener("mousedown", (e) => {
      if (e.target === bg) {
        panel.classList.remove("nudge");
        void panel.offsetWidth;
        panel.classList.add("nudge");
        setTimeout(() => panel.classList.remove("nudge"), 170);
      }
    });
  }
  if (closeBtn) closeBtn.addEventListener("click", requestCloseModal);
  if (cancelBtn) cancelBtn.addEventListener("click", requestCloseModal);
}

bootstrap();
