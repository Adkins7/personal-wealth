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

export function parseYuanPreviewCents(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().replace(/,/g, "").replace(/^¥/, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
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

export const EXPENSE_CATEGORY_LABELS = {
  dining: "餐饮美食",
  shopping: "日常购物",
  transport: "交通出行",
  housing: "居家水电",
  entertainment: "休闲娱乐",
  medical: "医疗健康",
  social: "人情往来",
  other: "其他支出",
};

export const COMMON_BANKS = [
  "招商银行",
  "工商银行",
  "建设银行",
  "农业银行",
  "中国银行",
  "交通银行",
  "邮储银行",
  "中信银行",
  "浦发银行",
  "兴业银行",
  "民生银行",
  "光大银行",
  "平安银行",
  "广发银行",
  "华夏银行",
  "北京银行",
  "上海银行",
  "江苏银行",
  "宁波银行",
  "南京银行",
  "杭州银行",
  "浙商银行",
  "渤海银行",
  "徽商银行",
  "成都银行",
  "微众银行",
  "网商银行",
  "汇丰银行",
  "渣打银行",
  "花旗银行",
  "美国运通",
];

export const OTHER_CREDIT_PLATFORMS = [
  "美团月付",
  "抖音月付",
  "微信分付",
  "拼多多先用后付",
  "分期乐",
  "招联好期贷",
  "度小满",
];
