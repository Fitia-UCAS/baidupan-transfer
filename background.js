const PAN_HOME = "https://pan.baidu.com/disk/main";
const PAN_MATCH = "https://pan.baidu.com/*";

chrome.runtime.onInstalled.addListener(() => {
  enableActionSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel();
});

enableActionSidePanel();

async function enableActionSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("Unable to enable Edge side panel behavior", error);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "baidupan-edge-background") {
    return false;
  }

  routeMessage(message)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "BACKGROUND_ERROR"
      });
    });

  return true;
});

async function routeMessage(message) {
  switch (message.type) {
    case "BAIDU_REQUEST":
      return requestBaidu(message.request, {
        createTab: Boolean(message.createTab),
        activateCreatedTab: Boolean(message.activateCreatedTab)
      });
    case "SET_SHARE_CREDENTIAL":
      return setShareCredential(message.randsk);
    case "OPEN_BAIDU":
      return openBaiduTab(message.url || PAN_HOME);
    case "GET_BRIDGE_STATUS":
      return getBridgeStatus();
    default:
      throw codedError("UNKNOWN_MESSAGE", "扩展收到了无法识别的内部消息。请重新加载扩展。 ");
  }
}

async function getBridgeStatus() {
  const tab = await findBestPanTab();
  if (!tab) {
    return { available: false };
  }
  await ensureBridgeInjected(tab.id);
  return { available: true, tabId: tab.id, url: tab.url || "" };
}

async function requestBaidu(request, options) {
  validateRequest(request);

  let tab = await findBestPanTab();
  if (!tab && options.createTab) {
    tab = await createBridgeTab(options.activateCreatedTab);
  }

  if (tab) {
    try {
      await ensureBridgeInjected(tab.id);
      return await chrome.tabs.sendMessage(tab.id, {
        type: "BAIDUPAN_EDGE_BRIDGE_FETCH",
        request
      });
    } catch (error) {
      console.warn("Baidu page bridge failed, trying extension fetch", error);
    }
  }

  // 登录状态接口通常允许扩展上下文直接访问。真实转存仍优先走百度网页标签页，
  // 这样 HttpOnly/SameSite Cookie 与网页端完全一致。
  if (!options.createTab) {
    return directExtensionFetch(request);
  }

  throw codedError(
    "BRIDGE_UNAVAILABLE",
    "无法连接百度网盘页面。请打开百度网盘并完成登录，然后点击“重新检测”。"
  );
}

async function directExtensionFetch(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs || 30000);
  try {
    const headers = new Headers(request.headers || {});
    let body;
    if (request.form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      body = new URLSearchParams(request.form).toString();
    }
    const response = await fetch(request.url, {
      method: request.method || "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers,
      body,
      signal: controller.signal
    });
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      contentType: response.headers.get("content-type") || "",
      text: await response.text(),
      via: "extension"
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw codedError("REQUEST_TIMEOUT", "连接百度网盘超时，请检查网络后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findBestPanTab() {
  const tabs = await chrome.tabs.query({ url: [PAN_MATCH] });
  if (!tabs.length) {
    return null;
  }

  return tabs
    .filter((tab) => typeof tab.id === "number")
    .sort((a, b) => scoreTab(b) - scoreTab(a))[0] || null;
}

function scoreTab(tab) {
  let score = 0;
  if (tab.status === "complete") score += 8;
  if (tab.active) score += 4;
  if (/\/disk\/(main|home)/.test(tab.url || "")) score += 3;
  if (/\/s\/1|\/share\//.test(tab.url || "")) score += 2;
  return score;
}

async function createBridgeTab(active) {
  const tab = await chrome.tabs.create({ url: PAN_HOME, active });
  if (typeof tab.id !== "number") {
    throw codedError("TAB_CREATE_FAILED", "无法打开百度网盘标签页。 ");
  }
  await waitForTab(tab.id, 20000);
  return chrome.tabs.get(tab.id);
}

async function waitForTab(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(codedError("TAB_LOAD_TIMEOUT", "百度网盘页面加载超时。"));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureBridgeInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "BAIDUPAN_EDGE_BRIDGE_PING" });
    if (pong?.ready) return;
  } catch {
    // Existing tabs are not guaranteed to receive a newly installed content script.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-bridge.js"]
  });

  const pong = await chrome.tabs.sendMessage(tabId, { type: "BAIDUPAN_EDGE_BRIDGE_PING" });
  if (!pong?.ready) {
    throw codedError("BRIDGE_INJECTION_FAILED", "无法连接百度网盘页面，请刷新该页面。 ");
  }
}

async function setShareCredential(randsk) {
  if (!randsk || typeof randsk !== "string") {
    throw codedError("INVALID_RANDSK", "提取码验证结果无效。 ");
  }

  const common = {
    url: "https://pan.baidu.com/",
    domain: ".baidu.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction"
  };

  await Promise.all([
    chrome.cookies.set({ ...common, name: "randsk", value: randsk }),
    chrome.cookies.set({ ...common, name: "BDCLND", value: randsk })
  ]);

  return { saved: true };
}

async function openBaiduTab(rawUrl) {
  const url = new URL(rawUrl, PAN_HOME);
  if (url.protocol !== "https:" || url.hostname !== "pan.baidu.com") {
    throw codedError("INVALID_OPEN_URL", "只允许打开百度网盘页面。 ");
  }
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  return { tabId: tab.id };
}

function validateRequest(request) {
  if (!request || typeof request.url !== "string") {
    throw codedError("INVALID_REQUEST", "内部请求缺少地址。 ");
  }
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname !== "pan.baidu.com") {
    throw codedError("INVALID_REQUEST_HOST", "扩展只允许访问 pan.baidu.com。 ");
  }
  const method = (request.method || "GET").toUpperCase();
  if (!new Set(["GET", "POST"]).has(method)) {
    throw codedError("INVALID_REQUEST_METHOD", "扩展只允许 GET 或 POST 请求。 ");
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
