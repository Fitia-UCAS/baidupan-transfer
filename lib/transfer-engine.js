import { BaiduApiError } from "./baidu-errors.js";
import { joinRemotePath } from "./link-parser.js";

const MAX_ITEMS_PER_REQUEST = 100;
const MAX_SCANNED_DIRECTORIES = 20000;

export class TransferCancelledError extends Error {
  constructor() {
    super("转存已停止。已经成功提交的批次不会被撤销。 ");
    this.name = "TransferCancelledError";
    this.code = "TRANSFER_CANCELLED";
  }
}

export class TransferEngine {
  constructor({ api, onEvent = () => {}, sleep = defaultSleep }) {
    this.api = api;
    this.onEvent = onEvent;
    this.sleep = sleep;
    this.cancelled = false;
    this.stats = this.createStats();
  }

  cancel() {
    this.cancelled = true;
  }

  async run({ share, targetPath }) {
    this.cancelled = false;
    this.stats = this.createStats();

    this.stage("检查登录状态", 8);
    const auth = await this.api.checkLogin({ createTab: true, activateCreatedTab: true });
    if (!auth.loggedIn) {
      throw new BaiduApiError(auth.reason || "未检测到百度网盘登录状态。", {
        code: "LOGIN_REQUIRED",
        loginRequired: true
      });
    }
    this.log("success", `已连接 Edge 中的百度网盘账号：${auth.name || "当前账号"}`);

    this.assertRunning();
    let pageInfo = null;
    if (share.password) {
      this.stage("验证分享提取码", 20);
      pageInfo = await this.api.accessSharePage(share);
      await this.api.verifyPassword(share, pageInfo, share.password);
      this.log("success", "提取码验证成功。 ");
    }

    this.assertRunning();
    this.stage("读取分享内容", 32);
    const root = await this.api.listRoot(share);
    const metadata = {
      ...root,
      shareUk: pageInfo?.shareUk || root.shareUk || root.uk,
      bdstoken: pageInfo?.bdstoken || this.api.bdstoken
    };
    this.stats.rootItems = root.items.length;
    this.stats.discoveredItems = root.items.length;
    this.emitStats();
    this.log("info", `发现 ${root.items.length} 个顶层项目。`);

    this.assertRunning();
    this.stage("准备保存目录", 42);
    await this.api.ensureDirectory(targetPath);
    this.log("success", `保存位置已就绪：${targetPath}`);

    if (!root.items.length) {
      this.stage("没有可转存内容", 100);
      return { status: "empty", stats: { ...this.stats } };
    }

    this.stage("正在转存", 50);
    const groups = chunk(root.items, MAX_ITEMS_PER_REQUEST);
    for (let index = 0; index < groups.length; index += 1) {
      this.assertRunning();
      this.log("info", `处理顶层批次 ${index + 1}/${groups.length}（${groups[index].length} 项）…`);
      await this.transferGroup(share, metadata, groups[index], targetPath, 0);
    }

    this.stage(this.stats.pendingTasks ? "任务已提交" : "转存完成", 100);
    const status = this.stats.pendingTasks ? "submitted" : "success";
    return { status, stats: { ...this.stats } };
  }

  async transferGroup(share, metadata, items, targetPath, depth) {
    this.assertRunning();
    if (!items.length) return;

    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const result = await this.api.transferItems(
          share,
          metadata,
          items.map((item) => item.id),
          targetPath
        );
        this.stats.batchesSucceeded += 1;
        this.stats.submittedItems += items.length;
        if (result.submitted) {
          this.stats.pendingTasks += 1;
          this.log("warning", `百度已接收异步任务 ${result.taskId}，但暂未返回完成状态；请勿重复提交。`);
        } else {
          this.log("success", `${indent(depth)}已转存 ${items.length} 项到 ${targetPath}`);
        }
        this.emitStats();
        await this.pace();
        return;
      } catch (error) {
        this.assertRunning();
        if (error?.transient && attempt < 3) {
          const waitMs = 900 * 2 ** (attempt - 1);
          this.log("warning", `百度暂时响应超时，${Math.round(waitMs / 100) / 10} 秒后重试本批次…`);
          await this.sleep(waitMs);
          continue;
        }

        if (error?.limitExceeded) {
          await this.handleLimitExceeded(share, metadata, items, targetPath, depth);
          return;
        }

        if (error?.duplicate) {
          await this.handleDuplicate(share, metadata, items, targetPath, depth);
          return;
        }

        throw error;
      }
    }
  }

  async handleLimitExceeded(share, metadata, items, targetPath, depth) {
    if (items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      this.log("warning", `${indent(depth)}本批次超过账号数量上限，拆为 ${middle} + ${items.length - middle} 项。`);
      await this.transferGroup(share, metadata, items.slice(0, middle), targetPath, depth);
      await this.transferGroup(share, metadata, items.slice(middle), targetPath, depth);
      return;
    }

    const item = items[0];
    if (!item.isDir) {
      throw new BaiduApiError(`单个文件“${item.name}”仍被百度判定为数量超限，无法继续拆分。`, {
        code: "UNSPLITTABLE_LIMIT",
        limitExceeded: true
      });
    }

    await this.expandDirectory(share, metadata, item, targetPath, depth);
  }

  async handleDuplicate(share, metadata, items, targetPath, depth) {
    if (items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      this.log("warning", `${indent(depth)}批次中存在同名内容，正在拆开处理其余项目。`);
      await this.transferGroup(share, metadata, items.slice(0, middle), targetPath, depth);
      await this.transferGroup(share, metadata, items.slice(middle), targetPath, depth);
      return;
    }

    const item = items[0];
    if (item.isDir) {
      this.log("warning", `${indent(depth)}目录“${item.name}”已存在，改为合并其内部内容。`);
      await this.expandDirectory(share, metadata, item, targetPath, depth);
      return;
    }

    this.stats.skippedDuplicates += 1;
    this.log("warning", `${indent(depth)}跳过同名文件：${item.name}`);
    this.emitStats();
  }

  async expandDirectory(share, metadata, directory, targetPath, depth) {
    this.assertRunning();
    this.stats.scannedDirectories += 1;
    this.stats.splitDirectories += 1;
    if (this.stats.scannedDirectories > MAX_SCANNED_DIRECTORIES) {
      throw new BaiduApiError("目录层级或数量异常，已停止以避免无限递归。", {
        code: "DIRECTORY_SCAN_LIMIT"
      });
    }

    const destination = joinRemotePath(targetPath, directory.name);
    const sourcePath = directory.path || joinSourcePath(metadata.rootPath, directory.name);
    this.log("warning", `${indent(depth)}目录数量超过限制，正在拆分处理：${directory.name}`);
    this.emitStats();

    await this.api.ensureDirectory(destination);
    const children = await this.api.listDirectory(share, metadata, sourcePath);
    this.stats.discoveredItems += children.length;
    this.emitStats();

    if (!children.length) {
      this.log("success", `${indent(depth + 1)}已创建空目录：${destination}`);
      return;
    }

    const groups = chunk(children, MAX_ITEMS_PER_REQUEST);
    for (const group of groups) {
      this.assertRunning();
      await this.transferGroup(share, metadata, group, destination, depth + 1);
    }
  }

  async pace() {
    await this.sleep(420 + Math.round(Math.random() * 280));
  }

  assertRunning() {
    if (this.cancelled) throw new TransferCancelledError();
  }

  stage(text, progress) {
    this.onEvent({ type: "stage", text, progress });
  }

  log(level, text) {
    this.onEvent({ type: "log", level, text, at: Date.now() });
  }

  emitStats() {
    this.onEvent({ type: "stats", stats: { ...this.stats } });
  }

  createStats() {
    return {
      rootItems: 0,
      discoveredItems: 0,
      submittedItems: 0,
      batchesSucceeded: 0,
      splitDirectories: 0,
      scannedDirectories: 0,
      skippedDuplicates: 0,
      pendingTasks: 0
    };
  }
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function joinSourcePath(parent, child) {
  const base = String(parent || "").replace(/\/$/, "");
  return `${base}/${child}`.replace(/\/+/g, "/");
}

function indent(depth) {
  return depth ? `${"　".repeat(Math.min(depth, 6))}↳ ` : "";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
