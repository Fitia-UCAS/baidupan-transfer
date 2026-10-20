(() => {
  if (globalThis.__baidupanEdgeBridgeInstalled) {
    return;
  }
  globalThis.__baidupanEdgeBridgeInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BAIDUPAN_EDGE_BRIDGE_PING") {
      sendResponse({ ready: true, page: location.href });
      return false;
    }

    if (message?.type !== "BAIDUPAN_EDGE_BRIDGE_FETCH") {
      return false;
    }

    fetchForExtension(message.request)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          bridgeError: true,
          error: error instanceof Error ? error.message : String(error),
          code: error?.name === "AbortError" ? "REQUEST_TIMEOUT" : "BRIDGE_FETCH_FAILED"
        });
      });

    return true;
  });

  async function fetchForExtension(request) {
    const url = new URL(request.url, location.origin);
    if (url.protocol !== "https:" || url.hostname !== "pan.baidu.com") {
      throw new Error("请求被页面桥接器拒绝：只允许访问 pan.baidu.com。 ");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs || 30000);

    try {
      const headers = new Headers(request.headers || {});
      headers.delete("cookie");
      headers.delete("origin");
      headers.delete("host");
      headers.set("X-Requested-With", "XMLHttpRequest");

      let body;
      if (request.form) {
        headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        body = new URLSearchParams(request.form).toString();
      }

      const referrer = request.referrer || location.href;
      const response = await fetch(url.href, {
        method: (request.method || "GET").toUpperCase(),
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers,
        body,
        referrer,
        referrerPolicy: "strict-origin-when-cross-origin",
        signal: controller.signal
      });

      return {
        status: response.status,
        ok: response.ok,
        url: response.url,
        contentType: response.headers.get("content-type") || "",
        text: await response.text(),
        via: "baidu-tab"
      };
    } finally {
      clearTimeout(timer);
    }
  }
})();
