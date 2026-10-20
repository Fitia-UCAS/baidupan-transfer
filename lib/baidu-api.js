import { asFlag, asId, asInteger, parseJsonLossless } from "./json-utils.js";
import { BaiduApiError, describeErrno, errorFromPayload } from "./baidu-errors.js";

const APP_ID = "250528";
const PAN_ORIGIN = "https://pan.baidu.com";
const DEFAULT_REFERER = `${PAN_ORIGIN}/disk/main`;
const PAGE_SIZE = 100;

export class BaiduApi {
  constructor({ transport, setShareCredential, sleep = defaultSleep }) {
    this.transport = transport;
    this.setShareCredential = setShareCredential;
    this.sleep = sleep;
    this.bdstoken = "";
    this.randsk = "";
  }

  async checkLogin(options = {}) {
    const attempts = [
      {
        path: "/api/loginStatus",
        params: { clienttype: "0", app_id: APP_ID, web: "1" },
        read: (json) => ({
          token: json?.login_info?.bdstoken,
          name:
            json?.login_info?.username ||
            json?.login_info?.display_name ||
            json?.login_info?.baidu_name ||
            "当前账号",
          uk: asId(json?.login_info?.uk)
        })
      },
      {
        path: "/api/gettemplatevariable",
        params: {
          clienttype: "0",
          app_id: APP_ID,
          web: "1",
          fields: JSON.stringify(["bdstoken", "uk", "username"])
        },
        read: (json) => ({
          token: json?.result?.bdstoken,
          name: json?.result?.username || "当前账号",
          uk: asId(json?.result?.uk)
        })
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const json = await this.requestJson(attempt.path, {
          params: attempt.params,
          referrer: DEFAULT_REFERER,
          createTab: Boolean(options.createTab),
          activateCreatedTab: Boolean(options.activateCreatedTab),
          context: "登录状态响应"
        });
        const info = attempt.read(json);
        if (typeof info.token === "string" && info.token.trim()) {
          this.bdstoken = info.token.trim();
          return { loggedIn: true, bdstoken: this.bdstoken, name: info.name, uk: info.uk };
        }
      } catch (error) {
        lastError = error;
      }
    }

    return {
      loggedIn: false,
      reason: lastError?.message || "百度网盘接口没有返回有效登录令牌。"
    };
  }

  async accessSharePage(share) {
    const response = await this.requestText(share.sharePageUrl, {
      referrer: DEFAULT_REFERER,
      createTab: true,
      context: "分享页面"
    });
    const body = response.text;

    // Normal Baidu share pages include passport.baidu.com and “登录” in common
    // navigation scripts even when the account is already signed in. Only treat
    // an actual redirect to the passport host as a lost login.
    if (isPassportUrl(response.url)) {
      throw new BaiduApiError("当前 Edge 中的百度网盘登录已经失效，请重新登录。", {
        code: "LOGIN_REQUIRED",
        loginRequired: true
      });
    }

    if (
      body.includes("platform-non-found") ||
      body.includes("error-404") ||
      body.includes("百度网盘-链接不存在") ||
      /"share_page_type"\s*:\s*"error"/.test(body)
    ) {
      throw new BaiduApiError("分享链接不存在、已取消或已经失效。", {
        code: "SHARE_NOT_FOUND",
        errno: 13004
      });
    }

    const shareid = firstMatch(body, /"shareid"\s*:\s*"?(\d+)"?/);
    const uk = firstMatch(body, /"uk"\s*:\s*"?(\d+)"?/);
    const shareUk = firstMatch(body, /"share_uk"\s*:\s*"?(\d+)"?/) || uk;
    const pageToken = firstMatch(body, /"bdstoken"\s*:\s*"([^"]+)"/);
    const needsPassword =
      body.includes("请输入提取码") || body.includes("accesscode") || body.includes("verify-form");

    return {
      shareid,
      uk,
      shareUk,
      bdstoken: pageToken || this.bdstoken,
      needsPassword,
      bodyLength: body.length
    };
  }

  async verifyPassword(share, pageInfo, password) {
    if (!password) {
      throw new BaiduApiError("该分享需要提取码。", { code: "PASSWORD_REQUIRED", errno: -9 });
    }

    let payload;
    if (pageInfo?.shareid && pageInfo?.shareUk) {
      payload = await this.requestJson("/share/verify", {
        params: {
          shareid: pageInfo.shareid,
          uk: pageInfo.shareUk,
          t: String(Date.now()),
          clienttype: "1"
        },
        method: "POST",
        form: {
          pwd: password,
          vcode: "",
          vcode_str: "",
          bdstoken: pageInfo.bdstoken || this.bdstoken
        },
        referrer: share.sharePageUrl,
        createTab: true,
        context: "提取码验证响应"
      });
    } else {
      // Some password pages no longer embed shareid/uk. The older surl route is
      // retained as a compatibility fallback and is still accepted by the web API.
      payload = await this.requestJson("/share/verify", {
        params: {
          surl: share.surl,
          bdstoken: this.bdstoken,
          t: String(Date.now()),
          channel: "chunlei",
          web: "1",
          clienttype: "0"
        },
        method: "POST",
        form: { pwd: password, vcode: "", vcode_str: "" },
        referrer: share.sharePageUrl,
        createTab: true,
        context: "提取码兼容验证响应"
      });
    }

    if (asInteger(payload?.errno, -1) !== 0) {
      throw errorFromPayload(payload, "提取码验证失败");
    }
    const randsk = typeof payload?.randsk === "string" ? payload.randsk : "";
    if (!randsk) {
      throw new BaiduApiError("提取码已通过，但百度没有返回后续访问凭据。", {
        code: "RANDSK_MISSING",
        payload
      });
    }

    await this.setShareCredential(randsk);
    this.randsk = randsk;
    return randsk;
  }

  async listRoot(share) {
    const all = [];
    let page = 1;
    let metadata = null;

    while (page <= 10000) {
      const payload = await this.requestJson("/share/list", {
        params: {
          shorturl: share.surl,
          root: "1",
          order: "time",
          desc: "1",
          showempty: "0",
          web: "1",
          page: String(page),
          num: String(PAGE_SIZE),
          view_mode: "1",
          channel: "chunlei",
          app_id: APP_ID,
          bdstoken: this.bdstoken,
          clienttype: "0"
        },
        referrer: share.sharePageUrl,
        createTab: true,
        context: "分享根目录响应"
      });

      if (asInteger(payload?.errno, -1) !== 0) {
        throw errorFromPayload(payload, "读取分享目录失败");
      }

      const list = Array.isArray(payload?.list) ? payload.list.map(parseFileItem).filter(Boolean) : [];
      all.push(...list);
      if (!metadata) {
        metadata = {
          uk: asId(payload?.uk),
          shareid: asId(payload?.share_id) || asId(payload?.shareid),
          shareUk: asId(payload?.uk),
          rootPath: typeof payload?.title === "string" ? payload.title : ""
        };
      }

      const hasMore = asFlag(payload?.has_more) || list.length >= PAGE_SIZE;
      if (!hasMore || list.length === 0) break;
      page += 1;
      await this.sleep(180);
    }

    if (!metadata?.shareid || !metadata?.uk) {
      throw new BaiduApiError("百度返回了文件列表，但缺少分享身份信息。请刷新分享页后重试。", {
        code: "SHARE_METADATA_MISSING"
      });
    }

    return { ...metadata, items: all };
  }

  async listDirectory(share, metadata, sourcePath) {
    const all = [];
    let page = 1;

    while (page <= 10000) {
      const payload = await this.requestJson("/share/list", {
        params: {
          uk: metadata.uk,
          shareid: metadata.shareid,
          order: "name",
          desc: "0",
          showempty: "0",
          view_mode: "1",
          web: "1",
          page: String(page),
          num: String(PAGE_SIZE),
          dir: sourcePath,
          channel: "chunlei",
          app_id: APP_ID,
          bdstoken: this.bdstoken,
          clienttype: "0"
        },
        referrer: share.sharePageUrl,
        createTab: true,
        context: "分享子目录响应"
      });

      if (asInteger(payload?.errno, -1) !== 0) {
        throw errorFromPayload(payload, `读取目录“${sourcePath}”失败`);
      }

      const list = Array.isArray(payload?.list) ? payload.list.map(parseFileItem).filter(Boolean) : [];
      all.push(...list);
      const hasMore = asFlag(payload?.has_more) || list.length >= PAGE_SIZE;
      if (!hasMore || list.length === 0) break;
      page += 1;
      await this.sleep(180);
    }
    return all;
  }

  async ensureDirectory(path) {
    if (!path || path === "/") return;
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      if (await this.directoryExists(current)) continue;

      const payload = await this.requestJson("/api/create", {
        params: {
          a: "commit",
          clienttype: "0",
          app_id: APP_ID,
          web: "1",
          bdstoken: this.bdstoken
        },
        method: "POST",
        form: { path: current, isdir: "1", block_list: "[]" },
        referrer: DEFAULT_REFERER,
        createTab: true,
        context: "创建目录响应"
      });

      if (asInteger(payload?.errno, 0) !== 0 && !(await this.directoryExists(current))) {
        throw errorFromPayload(payload, `创建目录“${current}”失败`);
      }
    }
  }

  async directoryExists(path) {
    const payload = await this.requestJson("/api/list", {
      params: {
        order: "name",
        desc: "0",
        showempty: "0",
        web: "1",
        page: "1",
        num: "1",
        dir: path,
        app_id: APP_ID,
        bdstoken: this.bdstoken,
        clienttype: "0"
      },
      referrer: DEFAULT_REFERER,
      createTab: true,
      context: "目录检查响应"
    });

    const errno = asInteger(payload?.errno, -1);
    if (errno === 0) return true;
    if (errno === -9 || errno === -7 || errno === 2) return false;
    throw errorFromPayload(payload, `检查目录“${path}”失败`);
  }

  async transferItems(share, metadata, ids, targetPath) {
    if (!ids.length) return { success: true, paths: [] };
    if (ids.some((id) => !/^\d+$/.test(String(id)))) {
      throw new BaiduApiError("待转存项目的内部标识无效。", { code: "INVALID_FILE_ID" });
    }

    const payload = await this.requestJson("/share/transfer", {
      params: {
        shareid: metadata.shareid,
        from: metadata.shareUk || metadata.uk,
        bdstoken: this.bdstoken,
        app_id: APP_ID,
        channel: "chunlei",
        clienttype: "0",
        web: "1"
      },
      method: "POST",
      form: {
        fsidlist: `[${ids.join(",")}]`,
        path: targetPath || "/"
      },
      referrer: share.sharePageUrl,
      createTab: true,
      timeoutMs: 45000,
      context: "转存响应"
    });

    const errno = asInteger(payload?.errno, -1);
    if (errno !== 0) {
      throw errorFromPayload(payload, "转存失败");
    }

    const taskId = asId(payload?.task_id);
    const immediateEntries = payload?.extra?.list;
    if (taskId && taskId !== "0" && !Array.isArray(immediateEntries)) {
      return this.queryTransferTask(share, metadata, taskId);
    }

    return {
      success: true,
      async: false,
      paths: collectResultPaths(immediateEntries),
      payload
    };
  }

  async queryTransferTask(share, metadata, taskId) {
    const maxAttempts = 24;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) await this.sleep(pollDelay(attempt));

      const payload = await this.requestJson("/share/taskquery", {
        params: {
          taskid: taskId,
          shareid: metadata.shareid,
          from: metadata.shareUk || metadata.uk,
          bdstoken: this.bdstoken,
          app_id: APP_ID,
          channel: "chunlei",
          clienttype: "0",
          web: "1"
        },
        referrer: share.sharePageUrl,
        createTab: true,
        context: "异步转存任务响应"
      });

      const errno = asInteger(payload?.errno, -1);
      if (errno !== 0) throw errorFromPayload(payload, "查询转存任务失败");

      const taskErrno = asInteger(payload?.task_errno, 0);
      if (taskErrno !== 0) {
        throw errorFromPayload({ ...payload, errno: taskErrno }, "异步转存任务失败");
      }

      const status = String(payload?.status || "").toLowerCase();
      if (status === "success" || Array.isArray(payload?.list)) {
        return {
          success: true,
          async: true,
          taskId,
          paths: collectResultPaths(payload?.list),
          payload
        };
      }
      if (status === "failed" || status === "error") {
        throw new BaiduApiError(payload?.show_msg || "百度异步转存任务失败。", {
          code: "ASYNC_TRANSFER_FAILED",
          payload
        });
      }
    }

    return {
      success: false,
      submitted: true,
      async: true,
      taskId,
      paths: []
    };
  }

  async requestJson(pathOrUrl, options = {}) {
    const response = await this.requestText(pathOrUrl, options);
    const payload = parseJsonLossless(response.text, options.context || "百度网盘响应");
    return payload;
  }

  async requestText(pathOrUrl, options = {}) {
    const url = buildUrl(pathOrUrl, options.params);
    const result = await this.transport(
      {
        url,
        method: options.method || "GET",
        form: options.form,
        headers: options.headers,
        referrer: options.referrer || DEFAULT_REFERER,
        timeoutMs: options.timeoutMs || 30000
      },
      {
        createTab: Boolean(options.createTab),
        activateCreatedTab: Boolean(options.activateCreatedTab)
      }
    );

    if (result?.bridgeError) {
      throw new BaiduApiError(result.error || "百度网盘页面请求失败。", {
        code: result.code || "BRIDGE_FETCH_FAILED"
      });
    }
    if (!result || typeof result.text !== "string") {
      throw new BaiduApiError("没有收到百度网盘响应。", { code: "EMPTY_TRANSPORT_RESPONSE" });
    }
    if (Number(result.status) >= 400) {
      throw new BaiduApiError(`百度网盘返回 HTTP ${result.status}。`, {
        code: "HTTP_ERROR",
        payload: result
      });
    }
    return result;
  }
}

export function parseFileItem(item) {
  const id = asId(item?.fs_id) || asId(item?.fsid);
  if (!id) return null;
  const path = typeof item?.path === "string" ? item.path : "";
  const name =
    (typeof item?.server_filename === "string" && item.server_filename) ||
    path.split("/").filter(Boolean).pop() ||
    "未命名项目";
  return {
    id,
    name,
    path,
    isDir: asFlag(item?.isdir),
    size: typeof item?.size === "string" ? item.size : String(item?.size || 0)
  };
}

function collectResultPaths(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((item) => (typeof item?.to === "string" ? item.to : ""))
    .filter(Boolean);
}

function firstMatch(text, regex) {
  return text.match(regex)?.[1] || "";
}

function buildUrl(pathOrUrl, params = {}) {
  const url = new URL(pathOrUrl, PAN_ORIGIN);
  if (url.protocol !== "https:" || url.hostname !== "pan.baidu.com") {
    throw new BaiduApiError("内部请求地址不属于百度网盘。", { code: "INVALID_API_URL" });
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

function pollDelay(attempt) {
  if (attempt <= 5) return 800 + Math.round(Math.random() * 400);
  if (attempt <= 10) return 1600 + Math.round(Math.random() * 800);
  return 4000 + Math.round(Math.random() * 2000);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPassportUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "passport.baidu.com" || hostname.endsWith(".passport.baidu.com");
  } catch {
    return false;
  }
}

export { APP_ID, describeErrno };
