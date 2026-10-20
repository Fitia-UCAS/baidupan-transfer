const PERSONAL_HOSTS = new Set(["pan.baidu.com", "yun.baidu.com"]);
const CODE_PATTERN = /^[A-Za-z0-9]{4}$/;

export class InputError extends Error {
  constructor(message, code = "INVALID_INPUT") {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

/**
 * Extracts one personal Baidu Netdisk link from copied text.
 * URL fragments such as #list/path=... are deliberately discarded: they describe
 * the browser UI, not the share, and were the source of the original “链接出错了”.
 */
export function parseShareInput(rawInput, explicitPassword = "") {
  const input = String(rawInput || "").replace(/\u00a0/g, " ").trim();
  if (!input) {
    throw new InputError("请粘贴百度网盘分享链接。", "EMPTY_LINK");
  }

  const urlText = extractUrl(input);
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new InputError("没有识别到完整的百度网盘链接。", "MALFORMED_LINK");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InputError("分享链接必须以 http:// 或 https:// 开头。", "UNSUPPORTED_PROTOCOL");
  }
  if (!PERSONAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InputError("这不是百度网盘分享链接。", "WRONG_HOST");
  }

  if (/^\/(?:apaas|netdisk)\/share\/?$/i.test(url.pathname)) {
    throw new InputError(
      "这是企业版分享链接，目前这个 Edge 专版只处理个人版 /s/ 分享链接。",
      "ENTERPRISE_LINK"
    );
  }

  let shortKey = "";
  let surl = "";
  const shortMatch = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/i);
  if (shortMatch) {
    shortKey = shortMatch[1];
    if (!shortKey.startsWith("1") || shortKey.length < 2) {
      throw new InputError("分享短链格式不完整。", "INVALID_SHORT_KEY");
    }
    surl = shortKey.slice(1);
  } else if (/^\/share\/init\/?$/i.test(url.pathname)) {
    surl = (url.searchParams.get("surl") || "").trim();
    if (!surl) {
      throw new InputError("分享链接缺少 surl 参数。", "MISSING_SURL");
    }
    shortKey = `1${surl}`;
  } else {
    throw new InputError("目前支持 /s/1… 和 /share/init?surl=… 两种个人版链接。", "UNSUPPORTED_LINK");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(surl)) {
    throw new InputError("分享标识含有无法识别的字符。", "INVALID_SURL");
  }

  const password = pickPassword(explicitPassword, url, input);
  const canonicalUrl = new URL(`https://pan.baidu.com/s/${shortKey}`);
  if (password) canonicalUrl.searchParams.set("pwd", password);

  return {
    kind: "personal",
    shortKey,
    surl,
    password,
    canonicalUrl: canonicalUrl.href,
    sharePageUrl: `https://pan.baidu.com/s/${shortKey}`,
    removedFragment: Boolean(url.hash),
    originalUrl: url.href
  };
}

export function normalizeTargetPath(rawPath) {
  const raw = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!raw || raw === "/") return "/";

  if (/[<>|*?:\x00-\x1f]/.test(raw)) {
    throw new InputError("保存目录不能包含 < > | * ? : 或控制字符。", "INVALID_TARGET_PATH");
  }

  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) return "/";
  if (parts.some((part) => part === "." || part === "..")) {
    throw new InputError("保存目录不能包含 . 或 .. 路径段。", "INVALID_TARGET_PATH");
  }

  const normalized = `/${parts.join("/")}`;
  if (normalized.length > 240) {
    throw new InputError("保存目录过长，请缩短到 240 个字符以内。", "TARGET_PATH_TOO_LONG");
  }
  return normalized;
}

export function joinRemotePath(parent, child) {
  const base = normalizeTargetPath(parent);
  const name = String(child || "").trim();
  if (!name || name === "." || name === ".." || /[\\/<>|*?:\x00-\x1f]/.test(name)) {
    throw new InputError(`目录名“${name || "空"}”无法安全转存。`, "INVALID_REMOTE_NAME");
  }
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function extractUrl(input) {
  const match = input.match(/https?:\/\/(?:pan|yun)\.baidu\.com\/[^\s<>"'，。；）】]+/i);
  if (!match) {
    throw new InputError("没有识别到百度网盘网址。", "LINK_NOT_FOUND");
  }
  return match[0].replace(/[),.;，。；）】]+$/u, "");
}

function pickPassword(explicitPassword, url, input) {
  const explicit = String(explicitPassword || "").trim();
  const fromQuery = String(url.searchParams.get("pwd") || "").trim();
  const fromText = input.match(/(?:提取码|提取|密码)\s*[：:]?\s*([A-Za-z0-9]{4})/i)?.[1] || "";
  const trailing = input
    .replace(extractUrl(input), " ")
    .match(/(?:^|\s)([A-Za-z0-9]{4})(?:\s|$)/)?.[1] || "";
  const selected = explicit || fromQuery || fromText || trailing;

  if (selected && !CODE_PATTERN.test(selected)) {
    throw new InputError("提取码应为 4 位字母或数字。", "INVALID_PASSWORD");
  }
  return selected;
}
