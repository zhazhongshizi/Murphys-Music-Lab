import type { ProviderId } from "../contracts/providers";
import { trackProvider } from "../contracts/providerIdentity";

/** Only the legacy QQ/local envelope may omit source. New DTOs always carry it. */
export function trackSource(record: Record<string, unknown>): { providerId?: ProviderId } {
  if (!("providerId" in record)) {
    const source = typeof record.id === "string" ? trackProvider(record.id) : null;
    if (source === "netease" || source === "bilibili") throw new Error("invalid_track_source");
    return {};
  }
  const inferred = typeof record.id === "string" ? trackProvider(record.id) : null;
  if (!inferred || inferred !== record.providerId) throw new Error("invalid_track_source");
  return { providerId: inferred };
}
