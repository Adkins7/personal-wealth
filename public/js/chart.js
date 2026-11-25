import { escapeHtml, formatMoney, pnlClass } from "./format.js";

export function renderNetWorthChart(container, snapshots, masked) {
  if (!container) return;

  if (!snapshots || snapshots.length === 0) {
    container.innerHTML = `
      <div class="empty-box">
        <div style="font-weight:500;color:var(--ink);margin-bottom:4px;">尚未生成每日资产快照</div>
        <div>录入账户余额后点击右上角「记录今日快照」，这里将自动绘制净资产长期走势曲线。</div>
      </div>
    `;
    return;
  }

  const recent = snapshots.slice(-30);
  const width = 820;
  const height = 220;
  const padLeft = 14;
  const padRight = 14;
  const padTop = 22;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const vals = recent.map((s) => Number(s.net_worth_cents));
  const minVal = Math.min(...vals);
  const maxVal = Math.max(...vals);
  const span = maxVal - minVal;
  const safeSpan = span === 0 ? Math.max(Math.abs(maxVal) * 0.1, 10000) : span;
  const yMin = span === 0 ? minVal - safeSpan / 2 : minVal - safeSpan * 0.14;
  const yMax = span === 0 ? maxVal + safeSpan / 2 : maxVal + safeSpan * 0.14;

  const getX = (i) =>
    recent.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (recent.length - 1)) * plotW;
  const getY = (val) => padTop + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const points = recent.map((snap, i) => ({
    x: getX(i),
    y: getY(Number(snap.net_worth_cents)),
    snap,
  }));

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + plotH).toFixed(
          1
        )} L ${points[0].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
      : "";

  const hitW = recent.length > 1 ? plotW / recent.length : plotW;

  const xLabels = points
    .map((p, idx) => {
      const show =
        points.length <= 7 ||
        idx === 0 ||
        idx === points.length - 1 ||
        idx === Math.floor(points.length / 2);
      if (!show) return "";
      const anchor =
        idx === 0 && points.length > 1
          ? "start"
          : idx === points.length - 1 && points.length > 1
          ? "end"
          : "middle";
      return `<text x="${p.x.toFixed(1)}" y="${
        height - 7
      }" text-anchor="${anchor}" fill="#94a3b8" font-size="11" class="num">${escapeHtml(
        p.snap.snapshot_date.slice(5)
      )}</text>`;
    })
    .join("");

  container.innerHTML = `
    <div id="chart-callout" style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:12px;padding:0 2px;"></div>
    <div style="width:100%;overflow:hidden;">
      <svg id="nw-svg" viewBox="0 0 ${width} ${height}" style="width:100%;height:215px;display:block;user-select:none;">
        <defs>
          <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#0f172a" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line x1="${padLeft}" x2="${width - padRight}" y1="${padTop}" y2="${padTop}" stroke="#e2e8f0" stroke-dasharray="3 3" stroke-width="1"/>
        <line x1="${padLeft}" x2="${width - padRight}" y1="${padTop + plotH / 2}" y2="${padTop + plotH / 2}" stroke="#e2e8f0" stroke-dasharray="3 3" stroke-width="1"/>
        <line x1="${padLeft}" x2="${width - padRight}" y1="${padTop + plotH}" y2="${padTop + plotH}" stroke="#e2e8f0" stroke-width="1"/>
        ${areaPath ? `<path d="${areaPath}" fill="url(#nwGrad)"/>` : ""}
        ${
          points.length > 1
            ? `<path d="${linePath}" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
            : ""
        }
        <line id="nw-cursor-line" x1="0" x2="0" y1="${padTop}" y2="${padTop + plotH}" stroke="#cbd5e1" stroke-dasharray="3 3" stroke-width="1"/>
        ${points
          .map(
            (p, idx) => `
          <g class="nw-pt" data-idx="${idx}">
            <circle class="nw-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#ffffff" stroke="#0f172a" stroke-width="1.6"/>
            <rect x="${(p.x - hitW / 2).toFixed(1)}" y="0" width="${hitW.toFixed(1)}" height="${height}" fill="transparent" style="cursor:pointer;"/>
          </g>`
          )
          .join("")}
        ${xLabels}
      </svg>
    </div>
  `;

  const callout = container.querySelector("#chart-callout");
  const cursorLine = container.querySelector("#nw-cursor-line");
  const dots = container.querySelectorAll(".nw-dot");

  function setActive(idx) {
    const pt = points[idx] || points[points.length - 1];
    const s = pt.snap;
    cursorLine.setAttribute("x1", pt.x.toFixed(1));
    cursorLine.setAttribute("x2", pt.x.toFixed(1));

    dots.forEach((d, i) => {
      if (i === idx) {
        d.setAttribute("r", "4.8");
        d.setAttribute("fill", "#0f172a");
      } else {
        d.setAttribute("r", "2.8");
        d.setAttribute("fill", "#ffffff");
      }
    });

    const deltaHtml =
      s.net_worth_change_cents !== null
        ? `<span class="num ${pnlClass(s.net_worth_change_cents)}" style="font-size:12.5px;font-weight:500;">
            ${formatMoney(s.net_worth_change_cents, { masked, showSign: true })}
            ${s.prev_snapshot_date ? `(较 ${escapeHtml(s.prev_snapshot_date.slice(5))})` : ""}
           </span>`
        : `<span class="text-subtle" style="font-size:12px;">首条基准快照</span>`;

    callout.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
        <span class="num text-muted" style="font-size:12.5px;font-weight:500;">${escapeHtml(
          s.snapshot_date
        )}</span>
        <span class="num" style="font-size:19px;font-weight:650;letter-spacing:-0.02em;">${formatMoney(
          s.net_worth_cents,
          { masked }
        )}</span>
        ${deltaHtml}
      </div>
      <div class="num" style="display:flex;align-items:center;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap;">
        <span>投资盈亏(独立): <strong class="${pnlClass(
          s.daily_investment_pnl_cents
        )}">${formatMoney(s.daily_investment_pnl_cents, { masked, showSign: true })}</strong></span>
        <span>羊毛结余(独立): <strong class="${pnlClass(
          s.wool_daily_balance_cents
        )}">${formatMoney(s.wool_daily_balance_cents, { masked, showSign: true })}</strong></span>
        <span>囤货口径: <strong style="color:var(--ink-secondary);">${
          s.stockpile_mode_used === "market" ? "当前估值" : "成本价"
        }</strong></span>
      </div>
    `;
  }

  setActive(points.length - 1);

  container.querySelectorAll(".nw-pt").forEach((el) => {
    const idx = Number(el.getAttribute("data-idx"));
    el.addEventListener("mouseenter", () => setActive(idx));
    el.addEventListener("click", () => setActive(idx));
  });

  const svg = container.querySelector("#nw-svg");
  svg.addEventListener("mouseleave", () => setActive(points.length - 1));
}
