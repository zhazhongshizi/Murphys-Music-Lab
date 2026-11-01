import type { NewProviderId } from "../contracts/providers";
const sessions = { netease: { key: "", revision: 0 }, bilibili: { key: "", revision: 0 } };
const listeners = new Set<(id: NewProviderId) => void>();
export function observeProviderSession(id: NewProviderId, key: string) {
  if (sessions[id].key !== key) { sessions[id].key = key; invalidateProviderSession(id); }
}
export function invalidateProviderSession(id: NewProviderId) { sessions[id].revision++; listeners.forEach(fn => fn(id)); }
export const providerSessionRevision = (id: NewProviderId) => sessions[id].revision;
export function subscribeProviderSessions(fn: (id: NewProviderId) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
