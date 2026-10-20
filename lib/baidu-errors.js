const ERROR_MESSAGES = new Map([
  [-32, "百度网盘剩余空间不足，请清理空间后重试。"],
  [-19, "百度要求输入验证码，请先在分享页面完成验证。"],
  [-12, "提取码错误，或分享链接类型与个人版不匹配。"],
  [-9, "提取码错误，或分享链接已经失效。"],
  [-7, "分享已删除、取消或失效。"],
  [-6, "登录状态已失效，请重新登录百度网盘。"],
  [-4, "当前百度账号登录状态无效。"],
  [-3, "当前百度账号登录状态无效。"],
  [-62, "访问过于频繁，百度已触发风控。请稍后再试，避免连续重复提交。"],
  [2, "目标目录不存在，扩展将尝试重新创建。"],
  [4, "请求暂时超时，或目标位置存在同名内容。"],
  [12, "本批次超过账号的单次转存数量上限。"],
  [20, "百度网盘剩余空间不足。"],
  [105, "分享页面不存在。"],
  [132, "百度检测到账号安全风险，请先在网页端完成安全验证。"],
  [1504, "百度服务器处理超时，请稍后重试。"],
  [8001, "百度已触发安全验证，请先在网页端完成验证。"],
  [13003, "该分享需要提取码，或提取码不正确。"],
  [13004, "分享链接已失效、已取消或不存在。"],
  [13071, "已有其他转存任务正在执行，请稍后再试。"],
  [13072, "已达到账号单次转存数量上限。"],
  [13073, "已达到账号单次转存数量上限。"]
]);

export class BaiduApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BaiduApiError";
    this.code = options.code ?? "BAIDU_API_ERROR";
    this.errno = options.errno;
    this.payload = options.payload;
    this.limitExceeded = Boolean(options.limitExceeded);
    this.duplicate = Boolean(options.duplicate);
    this.transient = Boolean(options.transient);
    this.loginRequired = Boolean(options.loginRequired);
  }
}

export function describeErrno(errno, fallback = "百度网盘返回了未知错误。") {
  return ERROR_MESSAGES.get(Number(errno)) || `${fallback}（错误码 ${errno}）`;
}

export function errorFromPayload(payload, context = "操作失败") {
  const errno = Number(payload?.errno ?? payload?.error_code ?? -1);
  const nested = Array.isArray(payload?.info)
    ? payload.info.map((item) => Number(item?.errno)).filter(Number.isFinite)
    : [];
  const innerErrno = nested.find((value) => value !== 0);
  const quota = innerErrno === -32 || errno === -32 || errno === 20;
  const limit = !quota && (
    errno === 12 ||
    errno === 13072 ||
    errno === 13073 ||
    nested.includes(130) ||
    (Number(payload?.target_file_nums_limit) > 0 &&
      Number(payload?.target_file_nums) > Number(payload?.target_file_nums_limit))
  );
  const duplicate = errno === 4 && Boolean(payload?.duplicated);
  const effectiveErrno = quota ? -32 : errno;
  const serverMessage = payload?.show_msg || payload?.errmsg || payload?.error_msg || "";
  const message = quota
    ? describeErrno(-32)
    : limit
      ? `本批次包含 ${payload?.target_file_nums || "过多"} 个文件，超过账号单次上限 ${payload?.target_file_nums_limit || ""}。`
      : serverMessage || describeErrno(effectiveErrno, context);

  return new BaiduApiError(message, {
    errno: effectiveErrno,
    payload,
    limitExceeded: limit,
    duplicate,
    transient: (errno === 4 && !duplicate) || errno === 1504,
    loginRequired: [-6, -4, -3].includes(errno)
  });
}
