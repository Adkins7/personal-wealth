/**
 * 金额与日期工具：全站后端与数据库统一使用人民币“分”（安全整数）存储和计算，彻底消除浮点数精度误差。
 * 日期与时间戳统一采用北京时间 (Asia/Shanghai)，确保在 Vercel 等海外 UTC 容器上“今日”口径一致。
 */

export function yuanToCents(input, allowNegative = false) {
  if (input === null || input === undefined || input === "") return 0;
  const cleaned = String(input).trim().replace(/,/g, "").replace(/^¥/, "");
  if (!cleaned) return 0;

  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) {
    const num = Number(cleaned);
    if (!Number.isFinite(num)) {
      throw new Error("请输入有效的金额数字（最多保留两位小数）");
    }
    const rounded = Math.round(num * 100);
    if (!allowNegative && rounded < 0) {
      throw new Error("该金额不能为负数");
    }
    if (!Number.isSafeInteger(rounded)) {
      throw new Error("金额超出安全范围");
    }
    return rounded;
  }

  const isNeg = cleaned.startsWith("-");
  if (isNeg && !allowNegative) {
    throw new Error("该金额不能为负数");
  }
  const unsigned = isNeg ? cleaned.slice(1) : cleaned;
  const [intPart, decPart = ""] = unsigned.split(".");
  const paddedDec = (decPart + "00").slice(0, 2);
  const cents = Number(intPart) * 100 + Number(paddedDec);
  if (!Number.isSafeInteger(cents)) {
    throw new Error("金额超出安全范围");
  }
  return isNeg ? -cents : cents;
}

export function centsToYuanString(cents) {
  const isNeg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const intPart = Math.floor(abs / 100);
  const decPart = String(abs % 100).padStart(2, "0");
  return `${isNeg ? "-" : ""}${intPart}.${decPart}`;
}

export function getLocalDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

export function getNowTimestampString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
