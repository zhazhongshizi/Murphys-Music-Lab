import type { AuthSnapshot } from "../../contracts/auth";

export function catalogAccessMessage(auth: AuthSnapshot, recovering: boolean): string | undefined {
  if (recovering) return "正在恢复账号";
  if (auth.state === "signedOut") return "请先登录后搜索或发现音乐";
  if (auth.state !== "authenticated") return "账号暂不可用，请重新登录";
  return undefined;
}
