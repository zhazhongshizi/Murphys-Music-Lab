import type {
  NewProviderId,
  ProviderAvailability,
  ProviderPage,
  ProviderTrack,
  ProviderVideo,
} from "../../contracts/providers";

export const MAX_PROVIDER_BATCH_ITEMS = 1_000;
export const MAX_PROVIDER_FULL_READ_PAGES = 100;
export const MAX_SEARCH_SELECT_ALL = 100;

export interface OrderedTrackSelection {
  readonly track: ProviderTrack;
  readonly position: number;
}

export function isProviderTrackPlayable(
  track: Pick<ProviderTrack, "availability">,
): boolean {
  return track.availability === "unknown";
}

export function isProviderVideoPlayable(
  video: Pick<ProviderVideo, "availability">,
): boolean {
  return video.availability === "unknown";
}

export function hasBrowsableProviderItems<T>(
  page: Pick<ProviderPage<T>, "page" | "hasMore" | "items"> | null | undefined,
): boolean {
  return Boolean(page && (page.items.length > 0 || page.hasMore || page.page > 1));
}

export function formatProviderAvailability(
  providerId: NewProviderId,
  availability: ProviderAvailability,
): string {
  switch (availability) {
    case "unknown":
      return providerId === "bilibili" ? "可尝试播放" : "待播放校验";
    case "authenticationRequired":
      return "需要登录";
    case "deleted":
      return "已失效或删除";
    case "permissionDenied":
      return "无播放权限";
    case "processing":
      return "处理中暂不可播";
    case "noAudio":
      return "无可用音频";
    case "unavailable":
    default:
      return "当前不可用";
  }
}

export function collectPlayableProviderTracks(
  tracks: readonly ProviderTrack[],
): {
  playable: ProviderTrack[];
  skippedUnavailable: number;
  skippedDuplicates: number;
} {
  const seen = new Set<string>();
  const playable: ProviderTrack[] = [];
  let skippedUnavailable = 0;
  let skippedDuplicates = 0;

  for (const track of tracks) {
    if (!isProviderTrackPlayable(track)) {
      skippedUnavailable++;
      continue;
    }
    if (seen.has(track.id)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(track.id);
    playable.push(track);
  }

  return { playable, skippedUnavailable, skippedDuplicates };
}

export function sortSelectedProviderTracks(
  selected: ReadonlyMap<string, OrderedTrackSelection>,
): ProviderTrack[] {
  return [...selected.values()]
    .sort((left, right) => left.position - right.position)
    .map(entry => entry.track);
}

export function filterProviderTracks(
  tracks: readonly ProviderTrack[],
  rawQuery: string,
): ProviderTrack[] {
  const query = rawQuery.trim().toLocaleLowerCase("zh-CN");
  if (!query) return [...tracks];
  return tracks.filter(track =>
    `${track.title} ${track.artist} ${track.album} ${track.video?.partTitle ?? ""}`
      .toLocaleLowerCase("zh-CN")
      .includes(query),
  );
}

export function filterProviderVideos(
  videos: readonly ProviderVideo[],
  rawQuery: string,
): ProviderVideo[] {
  const query = rawQuery.trim().toLocaleLowerCase("zh-CN");
  if (!query) return [...videos];
  return videos.filter(video =>
    `${video.title} ${video.uploader} ${video.bvid}`
      .toLocaleLowerCase("zh-CN")
      .includes(query),
  );
}

class IncompleteProviderPageError extends Error {
  readonly userMessage = "列表读取不完整，队列未修改；请刷新后重试";

  constructor(detail: string) {
    super(detail);
    this.name = "IncompleteProviderPageError";
  }
}

export async function readAllProviderPages<T>(
  fetchPage: (page: number, pageSize: number) => Promise<ProviderPage<T>>,
  pageSize: number,
  isCurrent: () => boolean,
  options?: {
    initialPage?: ProviderPage<T> | null;
    maxItems?: number;
    maxPages?: number;
    verifyCompleteTotal?: boolean;
    allowEmptyPages?: boolean;
  },
): Promise<{
  items: T[];
  total: number;
  truncated: boolean;
  aborted: boolean;
}> {
  const maxItems = options?.maxItems ?? MAX_PROVIDER_BATCH_ITEMS;
  const maxPages = options?.maxPages ?? MAX_PROVIDER_FULL_READ_PAGES;
  const items: T[] = [];
  let page = 1;
  let total = 0;
  let truncated = false;
  let expectedTotal: number | null | undefined;

  const acceptPage = (expectedPage: number, response: ProviderPage<T>): boolean => {
    if (response.page !== expectedPage) {
      throw new IncompleteProviderPageError("page_mismatch");
    }
    if (
      response.total !== null &&
      (!Number.isInteger(response.total) || response.total < 0)
    ) {
      throw new IncompleteProviderPageError("invalid_total");
    }
    if (expectedTotal === undefined) {
      expectedTotal = response.total;
    } else if (response.total !== expectedTotal) {
      throw new IncompleteProviderPageError("total_mismatch");
    }
    if (
      !options?.allowEmptyPages &&
      response.items.length === 0 &&
      (response.hasMore || expectedPage > 1)
    ) {
      throw new IncompleteProviderPageError("empty_page");
    }

    items.push(...response.items);
    total = Math.max(total, response.total ?? 0, items.length);

    if (!response.hasMore) {
      if (
        options?.verifyCompleteTotal &&
        expectedTotal !== null &&
        items.length < expectedTotal
      ) {
        throw new IncompleteProviderPageError("short_read");
      }
      if (items.length > maxItems) truncated = true;
      return true;
    }
    if (items.length >= maxItems || expectedPage === maxPages) {
      truncated = true;
      return true;
    }
    return false;
  };

  if (options?.initialPage && options.initialPage.page === 1) {
    if (acceptPage(1, options.initialPage)) {
      return {
        items: items.slice(0, maxItems),
        total: Math.max(total, items.length),
        truncated,
        aborted: false,
      };
    }
    page = 2;
  }

  for (; page <= maxPages; page++) {
    if (!isCurrent()) {
      return { items: [], total: 0, truncated: false, aborted: true };
    }
    const next = await fetchPage(page, pageSize);
    if (!isCurrent()) {
      return { items: [], total: 0, truncated: false, aborted: true };
    }
    if (acceptPage(page, next)) break;
  }

  return {
    items: items.slice(0, maxItems),
    total: Math.max(total, items.length),
    truncated: truncated || items.length > maxItems,
    aborted: false,
  };
}

/** Collects the first part (P1) of each playable, deduplicated video in a Bilibili folder. */
export async function collectBilibiliFolderFirstParts(
  fetchVideoPage: (page: number, pageSize: number) => Promise<ProviderPage<ProviderVideo>>,
  fetchVideoParts: (bvid: string, page: number, pageSize: number) => Promise<ProviderPage<ProviderTrack>>,
  isCurrent: () => boolean,
  initialPage?: ProviderPage<ProviderVideo> | null,
): Promise<{
  tracks: ProviderTrack[];
  skippedUnavailableVideos: number;
  skippedDuplicateVideos: number;
  truncated: boolean;
  aborted: boolean;
}> {
  const videoRead = await readAllProviderPages(fetchVideoPage, 20, isCurrent, {
    initialPage: initialPage && initialPage.page === 1 ? initialPage : null,
    allowEmptyPages: true,
  });
  if (videoRead.aborted || !isCurrent()) {
    return {
      tracks: [],
      skippedUnavailableVideos: 0,
      skippedDuplicateVideos: 0,
      truncated: false,
      aborted: true,
    };
  }
  const seenBvids = new Set<string>();
  const tracks: ProviderTrack[] = [];
  let skippedUnavailableVideos = 0;
  let skippedDuplicateVideos = 0;

  for (const video of videoRead.items) {
    if (!isCurrent()) {
      return {
        tracks: [],
        skippedUnavailableVideos: 0,
        skippedDuplicateVideos: 0,
        truncated: false,
        aborted: true,
      };
    }
    if (seenBvids.has(video.bvid)) {
      skippedDuplicateVideos += 1;
      continue;
    }
    seenBvids.add(video.bvid);
    if (!isProviderVideoPlayable(video)) {
      skippedUnavailableVideos += 1;
      continue;
    }
    const parts = await fetchVideoParts(video.bvid, 1, 100);
    if (!isCurrent()) {
      return {
        tracks: [],
        skippedUnavailableVideos: 0,
        skippedDuplicateVideos: 0,
        truncated: false,
        aborted: true,
      };
    }
    const firstPart = parts.items[0];
    if (!firstPart || !isProviderTrackPlayable(firstPart)) {
      skippedUnavailableVideos += 1;
      continue;
    }
    tracks.push(firstPart);
  }

  return {
    tracks,
    skippedUnavailableVideos,
    skippedDuplicateVideos,
    truncated: videoRead.truncated,
    aborted: false,
  };
}
