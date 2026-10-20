import { BaiduApi } from "./lib/baidu-api.js";
import { normalizeTargetPath, parseShareInput } from "./lib/link-parser.js";
import { TransferCancelledError, TransferEngine } from "./lib/transfer-engine.js";

const ui = {
  form: document.querySelector("#transferForm"),
  transferTabButton: document.querySelector("#transferTabButton"),
  outputTabButton: document.querySelector("#outputTabButton"),
  transferPanel: document.querySelector("#transferPanel"),
  outputPanel: document.querySelector("#outputPanel"),
  shareInput: document.querySelector("#shareInput"),
  passwordInput: document.querySelector("#passwordInput"),
  targetInput: document.querySelector("#targetInput"),
  pasteButton: document.querySelector("#pasteButton"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  inputError: document.querySelector("#inputError"),
  linkSummary: document.querySelector("#linkSummary"),
  linkSummaryText: document.querySelector("#linkSummaryText"),
  loginCard: document.querySelector("#loginCard"),
  loginTitle: document.querySelector("#loginTitle"),
  loginDetail: document.querySelector("#loginDetail"),
  loginAction: document.querySelector("#loginAction"),
  progressCard: document.querySelector("#progressCard"),
  progressContent: document.querySelector("#progressContent"),
  outputEmpty: document.querySelector("#outputEmpty"),
  stageText: document.querySelector("#stageText"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  statDiscovered: document.querySelector("#statDiscovered"),
  statBatches: document.querySelector("#statBatches"),
  statSkipped: document.querySelector("#statSkipped"),
  logList: document.querySelector("#logList"),
  clearLogButton: document.querySelector("#clearLogButton"),
  resultCard: document.querySelector("#resultCard"),
  resultTitle: document.querySelector("#resultTitle"),
  resultDetail: document.querySelector("#resultDetail"),
  openPanButton: document.querySelector("#openPanButton"),
  toast: document.querySelector("#toast")
};

const state = {
  engine: null,
  running: false,
  login: null,
  loginActionMode: "open",
  parseTimer: 0,
  toastTimer: 0
};

const api = new BaiduApi({
  transport: (request, options) =>
    sendBackground({
      type: "BAIDU_REQUEST",
      request,
      createTab: Boolean(options?.createTab),
      activateCreatedTab: Boolean(options?.activateCreatedTab)
    }),
  setShareCredential: (randsk) =>
    sendBackground({ type: "SET_SHARE_CREDENTIAL", randsk })
});

bindEvents();
initialize().catch((error) => {
  console.error("Unable to initialize side panel", error);
  setLoginCard("error", "初始化失败", "请重新加载扩展后再试");
  showToast(error?.message || "侧边栏初始化失败，请重新加载扩展。 ");
});

async function initialize() {
  const saved = await chrome.storage.local.get(["targetPath"]);
  if (typeof saved.targetPath === "string" && saved.targetPath.trim()) {
    ui.targetInput.value = saved.targetPath;
  }

  await prefillFromActiveTab();
  updateLinkSummary();
  await refreshLoginState();
}

function bindEvents() {
  ui.form.addEventListener("submit", startTransfer);
  ui.transferTabButton.addEventListener("click", () => setPanel("transfer"));
  ui.outputTabButton.addEventListener("click", () => setPanel("output"));
  ui.transferTabButton.addEventListener("keydown", handleTabKeydown);
  ui.outputTabButton.addEventListener("keydown", handleTabKeydown);
  ui.stopButton.addEventListener("click", stopTransfer);
  ui.pasteButton.addEventListener("click", pasteFromClipboard);
  ui.loginAction.addEventListener("click", handleLoginAction);
  ui.clearLogButton.addEventListener("click", () => ui.logList.replaceChildren());
  ui.openPanButton.addEventListener("click", () =>
    sendBackground({ type: "OPEN_BAIDU", url: "https://pan.baidu.com/disk/main" })
  );

  ui.shareInput.addEventListener("input", scheduleLinkSummary);
  ui.passwordInput.addEventListener("input", scheduleLinkSummary);
  ui.passwordInput.addEventListener("input", () => {
    ui.passwordInput.value = ui.passwordInput.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 4);
  });
  ui.targetInput.addEventListener("blur", () => {
    try {
      ui.targetInput.value = normalizeTargetPath(ui.targetInput.value);
      clearInputError();
    } catch (error) {
      showInputError(error.message);
    }
  });
}

function handleTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const showOutput = event.key === "ArrowRight" || event.key === "End";
  setPanel(showOutput ? "output" : "transfer");
  (showOutput ? ui.outputTabButton : ui.transferTabButton).focus();
}

async function prefillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !/^https:\/\/(?:pan|yun)\.baidu\.com\//i.test(tab.url)) return;
    if (!/\/(?:s\/|share\/init)/i.test(tab.url)) return;

    ui.shareInput.value = tab.url;
    const parsed = parseShareInput(tab.url);
    if (parsed.password) ui.passwordInput.value = parsed.password;
  } catch {
    // Active tab URLs may be unavailable on browser-internal pages; this is optional.
  }
}

async function refreshLoginState() {
  setLoginCard("checking", "正在检测登录…", "");
  ui.loginAction.hidden = true;

  try {
    const login = await api.checkLogin();
    state.login = login;
    if (login.loggedIn) {
      setLoginCard("online", "已登录", login.name === "当前账号" ? "" : login.name || "");
      state.loginActionMode = "refresh";
      ui.loginAction.textContent = "刷新";
      ui.loginAction.hidden = false;
    } else {
      setLoginCard("offline", "未登录", "请先登录百度网盘");
      state.loginActionMode = "open";
      ui.loginAction.textContent = "打开登录";
      ui.loginAction.hidden = false;
    }
  } catch (error) {
    state.login = { loggedIn: false, reason: error.message };
    setLoginCard("offline", "未登录", "请先登录百度网盘");
    state.loginActionMode = "open";
    ui.loginAction.textContent = "打开登录";
    ui.loginAction.hidden = false;
  }
}

async function handleLoginAction() {
  if (state.loginActionMode === "open") {
    try {
      await sendBackground({ type: "OPEN_BAIDU", url: "https://pan.baidu.com/disk/main" });
      state.loginActionMode = "refresh";
      ui.loginAction.textContent = "重新检测";
      showToast("请在新标签页完成登录，然后回来点击“重新检测”。");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  await refreshLoginState();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast("剪贴板里没有文字。 ");
      return;
    }
    ui.shareInput.value = text.trim();
    updateLinkSummary({ copyPassword: true });
    ui.shareInput.focus();
  } catch {
    showToast("无法读取剪贴板，请直接粘贴。 ");
  }
}

function scheduleLinkSummary() {
  clearTimeout(state.parseTimer);
  state.parseTimer = setTimeout(() => updateLinkSummary(), 180);
}

function updateLinkSummary(options = {}) {
  clearInputError();
  const value = ui.shareInput.value.trim();
  if (!value) {
    ui.linkSummary.hidden = true;
    return null;
  }

  try {
    const parsed = parseShareInput(value, ui.passwordInput.value);
    if (options.copyPassword && parsed.password && !ui.passwordInput.value) {
      ui.passwordInput.value = parsed.password;
    }
    const notes = ["链接已识别"];
    if (parsed.password) notes.push("提取码已识别");
    ui.linkSummaryText.textContent = notes.join(" · ");
    ui.linkSummary.hidden = false;
    return parsed;
  } catch (error) {
    ui.linkSummary.hidden = true;
    if (value.length > 12) showInputError(error.message);
    return null;
  }
}

async function startTransfer(event) {
  event.preventDefault();
  if (state.running) return;

  let share;
  let targetPath;
  try {
    share = parseShareInput(ui.shareInput.value, ui.passwordInput.value);
    targetPath = normalizeTargetPath(ui.targetInput.value);
    ui.targetInput.value = targetPath;
    if (!ui.passwordInput.value && share.password) ui.passwordInput.value = share.password;
    clearInputError();
  } catch (error) {
    showInputError(error.message);
    return;
  }

  await chrome.storage.local.set({ targetPath });
  resetTaskPresentation();
  setRunning(true);
  setPanel("output");

  const engine = new TransferEngine({ api, onEvent: handleEngineEvent });
  state.engine = engine;

  try {
    const result = await engine.run({ share, targetPath });
    if (result.status === "success") {
      showResult(
        "success",
        "转存完成",
        buildCompletionDetail(result.stats),
        true
      );
    } else if (result.status === "submitted") {
      showResult(
        "warning",
        "任务已提交，等待百度处理",
        `有 ${result.stats.pendingTasks} 个异步批次暂未返回最终状态，请勿重复提交；稍后在网盘中确认。`,
        true
      );
    } else {
      showResult("warning", "分享目录为空", "没有发现可转存的文件或文件夹。", false);
    }
    await refreshLoginState();
  } catch (error) {
    handleTransferError(error, share);
  } finally {
    state.engine = null;
    setRunning(false);
  }
}

function stopTransfer() {
  if (!state.engine) return;
  state.engine.cancel();
  ui.stopButton.disabled = true;
  appendLog("warning", "正在停止；当前已经发出的百度请求会先结束。 ");
}

function handleEngineEvent(event) {
  if (event.type === "stage") {
    setProgress(event.text, event.progress);
  } else if (event.type === "log") {
    appendLog(event.level, event.text, event.at);
  } else if (event.type === "stats") {
    updateStats(event.stats);
  }
}

function handleTransferError(error, share) {
  let message = error?.message || "发生了未知错误。";
  let title = "转存失败";

  if (error instanceof TransferCancelledError || error?.code === "TRANSFER_CANCELLED") {
    title = "已停止后续批次";
    message = "此前已成功提交的批次不会撤销，请在百度网盘中确认。";
    setProgress("已停止", Number(ui.progressPercent.textContent.replace("%", "")) || 0);
    showResult("warning", title, message, true);
    appendLog("warning", message);
    return;
  }

  if (error?.loginRequired || error?.code === "LOGIN_REQUIRED") {
    setLoginCard("offline", "登录已失效", "请重新登录百度网盘");
    state.loginActionMode = "open";
    ui.loginAction.textContent = "打开登录";
    ui.loginAction.hidden = false;
  }

  if (!share.password && [-9, -12, 13003].includes(Number(error?.errno))) {
    message = "该分享可能需要提取码。请填写 4 位提取码后重试；若仍失败，链接可能已失效。";
    setPanel("transfer");
    showInputError(message);
    ui.passwordInput.focus();
  }

  appendLog("error", message);
  showResult("error", title, message, Boolean(error?.loginRequired));
}

function resetTaskPresentation() {
  ui.progressContent.hidden = false;
  ui.outputEmpty.hidden = true;
  ui.resultCard.hidden = true;
  ui.resultCard.className = "result-card";
  ui.logList.replaceChildren();
  updateStats({});
  setProgress("正在准备…", 0);
}

function setRunning(running) {
  state.running = running;
  ui.startButton.disabled = running;
  ui.shareInput.disabled = running;
  ui.passwordInput.disabled = running;
  ui.targetInput.disabled = running;
  ui.pasteButton.disabled = running;
  ui.stopButton.hidden = !running;
  ui.stopButton.disabled = false;
  ui.startButton.querySelector(".button-label").textContent = running ? "正在处理…" : "开始转存";
}

function setProgress(text, rawProgress) {
  const progress = Math.max(0, Math.min(100, Number(rawProgress) || 0));
  ui.stageText.textContent = text;
  ui.progressPercent.textContent = `${Math.round(progress)}%`;
  ui.progressBar.style.width = `${progress}%`;
}

function updateStats(stats = {}) {
  ui.statDiscovered.textContent = String(stats.discoveredItems || 0);
  ui.statBatches.textContent = String(stats.batchesSucceeded || 0);
  ui.statSkipped.textContent = String(stats.skippedDuplicates || 0);
}

function appendLog(level, text, at = Date.now()) {
  const item = document.createElement("li");
  item.className = `log-entry ${level || "info"}`;
  const time = document.createElement("time");
  time.dateTime = new Date(at).toISOString();
  time.textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(at));
  const copy = document.createElement("span");
  copy.textContent = text;
  item.append(time, copy);
  ui.logList.append(item);
  while (ui.logList.children.length > 240) ui.logList.firstElementChild?.remove();
  ui.logList.scrollTop = ui.logList.scrollHeight;
}

function showResult(kind, title, detail, canOpenPan) {
  ui.resultCard.className = `result-card${kind === "success" ? "" : ` is-${kind}`}`;
  ui.resultTitle.textContent = title;
  ui.resultDetail.textContent = detail;
  ui.openPanButton.hidden = !canOpenPan;
  ui.resultCard.hidden = false;
  ui.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildCompletionDetail(stats) {
  const pieces = [`成功处理 ${stats.batchesSucceeded} 个批次`];
  if (stats.splitDirectories) pieces.push(`自动拆分 ${stats.splitDirectories} 个目录`);
  if (stats.skippedDuplicates) pieces.push(`跳过 ${stats.skippedDuplicates} 个同名文件`);
  return `${pieces.join("，")}。`;
}

function setLoginCard(status, title, detail) {
  ui.loginCard.className = `status-card is-${status}`;
  ui.loginTitle.textContent = title;
  ui.loginDetail.textContent = detail || "";
  ui.loginDetail.hidden = !detail;
}

function setPanel(name) {
  const output = name === "output";
  ui.transferPanel.hidden = output;
  ui.outputPanel.hidden = !output;
  ui.transferPanel.classList.toggle("active", !output);
  ui.outputPanel.classList.toggle("active", output);
  ui.transferTabButton.classList.toggle("active", !output);
  ui.outputTabButton.classList.toggle("active", output);
  ui.transferTabButton.setAttribute("aria-selected", String(!output));
  ui.outputTabButton.setAttribute("aria-selected", String(output));
  ui.transferTabButton.tabIndex = output ? -1 : 0;
  ui.outputTabButton.tabIndex = output ? 0 : -1;
}

function showInputError(message) {
  ui.inputError.textContent = message;
  ui.inputError.hidden = false;
}

function clearInputError() {
  ui.inputError.hidden = true;
  ui.inputError.textContent = "";
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 3600);
}

async function sendBackground(message) {
  const response = await chrome.runtime.sendMessage({
    target: "baidupan-edge-background",
    ...message
  });
  if (!response?.ok) {
    const error = new Error(response?.error || "扩展后台没有响应。请在 edge://extensions 中重新加载扩展。 ");
    error.code = response?.code || "BACKGROUND_ERROR";
    throw error;
  }
  return response.value;
}

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled extension rejection", event.reason);
});
