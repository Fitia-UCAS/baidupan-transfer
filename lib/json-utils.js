const LOSSLESS_KEYS = [
  "fs_id",
  "fsid",
  "shareid",
  "share_id",
  "share_uk",
  "uk",
  "task_id",
  "taskid",
  "to_fs_id"
];

const LOSSLESS_NUMBER_PATTERN = new RegExp(
  `("(?:${LOSSLESS_KEYS.join("|")})"\\s*:\\s*)(-?\\d+)`,
  "g"
);

/**
 * JSON.parse converts large integer IDs to IEEE-754 numbers. Baidu uses those IDs
 * as opaque strings, so quote selected numeric fields before parsing.
 */
export function parseJsonLossless(text, context = "百度网盘响应") {
  const source = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!source) {
    throw new Error(`${context}为空。`);
  }

  try {
    return JSON.parse(source.replace(LOSSLESS_NUMBER_PATTERN, '$1"$2"'));
  } catch (error) {
    const preview = source.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`${context}不是有效 JSON：${preview}`);
  }
}

export function asId(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return "";
}

export function asInteger(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

export function asFlag(value) {
  return value === true || value === 1 || value === "1";
}
