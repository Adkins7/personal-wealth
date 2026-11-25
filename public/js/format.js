export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMoney(cents, options = {}) {
  if (options.masked) {
    return "¥ ••••••";
  }
  const numCents = Number(cents || 0);
  const isNeg = numCents < 0;
  const isPos = numCents > 0;
  const yuan = Math.abs(Math.round(numCents)) / 100;
  const formatted = yuan.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = isNeg ? "-" : options.showSign && isPos ? "+" : "";
  return `${sign}¥${formatted}`;
}

export function centsToInputYuan(cents) {
  const num = Number(cents || 0);
  if (num === 0) return "0";
  const isNeg = num < 0;
  const abs = Math.abs(Math.round(num));
  const yuan = (abs / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${isNeg ? "-" : ""}${yuan}`;
}

export function pnlClass(cents) {
  const n = Number(cents || 0);
  if (n > 0) return "text-gain";
  if (n < 0) return "text-loss";
  return "";
}

export function pillClassForDelta(cents) {
  const n = Number(cents || 0);
  if (n > 0) return "pill-gain";
  if (n < 0) return "pill-loss";
  return "pill-neutral";
}

export const FUND_CATEGORY_LABELS = {
  stock: "股票账户",
  fund: "基金账户",
  debit_card: "储蓄卡",
  wechat_pay: "微信零钱",
  other: "其他资金",
};

export const CREDIT_CATEGORY_LABELS = {
  credit_card: "信用卡",
  huabei: "花呗",
  baitiao: "白条",
  other: "其他负债",
};

export const WOOL_TYPE_LABELS = {
  instant_discount: "立减金",
  coupon: "优惠券",
  resale: "买卖套利",
  cashback: "返现红包",
  other: "其他羊毛",
};

export const WOOL_STATUS_LABELS = {
  pending: "未兑现 / 未售出",
  sold: "已售出 / 已兑现",
  expired: "已过期 / 作废",
};
