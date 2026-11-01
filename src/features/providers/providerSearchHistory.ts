import { useState } from "react";
import type { NewProviderId } from "../../contracts/providers";

export type ProviderSearchKind = "songs" | "playlists" | "videos";
interface Entry { query: string; type: ProviderSearchKind }

// Keep platform searches separate from QQ history and from each other.
export function useProviderSearchHistory(id: NewProviderId) {
  const key = `qqmusic_${id}_search_history_v1`;
  const [entries, setEntries] = useState<Entry[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(raw) ? raw.filter((entry): entry is Entry =>
        entry && typeof entry.query === "string" && entry.query.trim() && entry.query.length <= 100 &&
        !/[\u0000-\u001f]/.test(entry.query) &&
        (id === "bilibili" ? entry.type === "videos" : entry.type === "songs" || entry.type === "playlists"),
      ).slice(0, 10) : [];
    } catch { return []; }
  });
  function save(next: Entry[]) {
    setEntries(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Search works without storage. */ }
  }
  return {
    entries,
    clear: () => save([]),
    remember(query: string, type: ProviderSearchKind) {
      query = query.trim();
      if (!query || query.length > 100 || /[\u0000-\u001f]/.test(query)) return;
      save([{ query, type }, ...entries.filter(entry => entry.query !== query || entry.type !== type)].slice(0, 10));
    },
  };
}
