import { nativeQueueEnqueueMany, nativeQueueEnqueueNext, nativeQueueSnapshot } from "../../backend/nativeQueueAdapter";
import { playbackSessionIdentity } from "../../backend/playbackTransport";
import { nativeProviderSongDetail, nativeProviderVideoParts, providerTrackToQueueTrack } from "../../backend/providersAdapter";
import { providerSessionRevision } from "../../backend/providerSessions";
import { trackProvider } from "../../contracts/providerIdentity";
import type { QueueTrack } from "../../contracts/queue";
import { playerActions } from "./playerStore";

export type StatisticsAction = "play" | "next" | "enqueue";
export async function actOnStatisticsTrack(row: { id: string; title: string; artist: string }, action: StatisticsAction) {
  const identity = playbackSessionIdentity();
  const current = await nativeQueueSnapshot();
  if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
  const provider = trackProvider(row.id);
  const newProvider = provider === "netease" || provider === "bilibili" ? provider : null;
  const revision = newProvider ? providerSessionRevision(newProvider) : null;
  const ensureCurrent = () => {
    if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
    if (newProvider && revision !== providerSessionRevision(newProvider)) throw new Error("来源账号已变化");
  };
  let track: QueueTrack | undefined = current.items.find(item => item.id === row.id);
  if (!track && newProvider) {
    if (newProvider === "netease") {
      const detail = await nativeProviderSongDetail("netease", row.id);
      ensureCurrent();
      if (detail.id !== row.id || detail.availability !== "unknown") throw new Error("歌曲当前不可用");
      track = providerTrackToQueueTrack(detail);
    } else {
      const bvid = row.id.split(":")[2]!;
      for (let page = 1; page <= 100; page++) {
        const result = await nativeProviderVideoParts(bvid, page, 100);
        ensureCurrent();
        if (result.page !== page) throw new Error("分 P 页码无效");
        const detail = result.items.find(item => item.id === row.id);
        if (detail) {
          if (detail.availability !== "unknown") throw new Error("此分 P 当前不可用");
          track = providerTrackToQueueTrack(detail);
          break;
        }
        if (!result.hasMore) break;
      }
      if (!track) throw new Error("此分 P 已不可用");
    }
  }
  track ??= { id: row.id, title: row.title, artist: row.artist, album: "", durationMs: 0 };
  ensureCurrent();
  const queue = action === "next" ? await nativeQueueEnqueueNext(track) : await nativeQueueEnqueueMany([track]);
  ensureCurrent();
  await playerActions.hydrateNative(queue);
  ensureCurrent();
  if (action === "play" && await playerActions.playTrack(row.id) === false) throw new Error("播放未启动");
}
