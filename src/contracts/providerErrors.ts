import type { ProviderErrorCode } from "./providers";

export const providerPersistenceMessage = (state: "saved" | "sessionOnly"): string =>
  state === "sessionOnly" ? "本次已登录，未能保存" : "登录信息已保存";

export const providerErrorMessages: Record<ProviderErrorCode, string> = {
  invalid_params: "请求参数无效", unsupported_capability: "此平台暂不支持该操作",
  authentication_required: "请先登录此平台", credential_invalid: "登录已失效，请重新扫码",
  network_unavailable: "网络暂时不可用，登录信息已保留", rate_limited: "请求过于频繁，请稍后手动重试",
  verification_required: "平台要求完成安全验证，请在官方客户端处理后稍候手动重试",
  verification_failed: "未能核对写入结果，请先刷新确认", entitlement_denied: "当前账号没有播放权限",
  preview_only: "当前账号仅可试听", media_unavailable: "音源不可用", unsupported_media: "暂不支持此音频格式",
  upstream_schema_changed: "平台接口发生变化", provider_unavailable: "平台进程不可用，请手动重试",
  outcome_unknown: "操作结果不确定，请先刷新核对", cancelled: "操作已取消", internal_error: "平台操作失败",
};
