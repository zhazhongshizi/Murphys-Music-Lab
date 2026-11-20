import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../backend/providersAdapter";
import { nativeQueueEnqueueNext, nativeQueueReplace } from "../backend/nativeQueueAdapter";
import type { NewProviderId, ProviderContainer, ProviderPage, ProviderSnapshot, ProviderTrack, ProviderVideo } from "../contracts/providers";
import constants from "../../contracts/protocol-v2.constants.json";
import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { RemoteProviderLibrary } from "./RemoteProviderLibrary";

vi.mock("../backend/providersAdapter", async original => ({
  ...(await original<typeof import("../backend/providersAdapter")>()),
  nativeProviderStatus: vi.fn(),
  nativeProviderContainer: vi.fn(),
  nativeProviderLibraryContainers: vi.fn(),
  nativeProviderLibraryLikes: vi.fn(),
  nativeProviderLibraryTracks: vi.fn(),
  nativeProviderLibraryVideos: vi.fn(),
  nativeProviderSearchSongs: vi.fn(),
  nativeProviderSearchPlaylists: vi.fn(),
  nativeProviderSearchVideos: vi.fn(),
  nativeProviderResolveVideo: vi.fn(),
  nativeProviderVideoParts: vi.fn(),
  nativeProviderEnqueueTrack: vi.fn(),
  nativeProviderEnqueueTracks: vi.fn(),
}));

vi.mock("../backend/nativeQueueAdapter", async original => ({
  ...(await original<typeof import("../backend/nativeQueueAdapter")>()),
  nativeQueueReplace: vi.fn(),
  nativeQueueEnqueueNext: vi.fn(),
}));

vi.mock("../features/player/playerStore", async original => {
  const mod = await original<typeof import("../features/player/playerStore")>();
  return {
    ...mod,
    playerActions: {
      ...mod.playerActions,
      playTrack: vi.fn(),
      hydrateNative: vi.fn(),
    },
  };
});

const readySnapshot = (providerId: NewProviderId): ProviderSnapshot => ({
  providerId,
  state: "ready",
  persistence: "saved",
  account: { providerId, id: "u-1", displayName: "远端测试号" },
  capabilities: constants.capabilities[providerId] as ProviderSnapshot["capabilities"],
});

const track1: ProviderTrack = {
  providerId: "netease",
  id: "netease:track:1",
  title: "远端歌曲一",
  artist: "歌手 A",
  creatorKind: "artist",
  album: "专辑 A",
  durationMs: 180_000,
  availability: "unknown",
};

const track2: ProviderTrack = {
  providerId: "netease",
  id: "netease:track:2",
  title: "远端歌曲二",
  artist: "歌手 B",
  creatorKind: "artist",
  album: "专辑 B",
  durationMs: 210_000,
  availability: "unknown",
};

const video1: ProviderVideo = {
  providerId: "bilibili",
  bvid: "BV17x411w7KC",
  aid: "170001",
  title: "远端测试视频",
  uploader: "测试 UP",
  durationMs: 120_000,
  availability: "unknown",
};

const part1: ProviderTrack = {
  providerId: "bilibili",
  id: "bilibili:video:BV17x411w7KC:123",
  title: "分 P 一",
  artist: "测试 UP",
  creatorKind: "uploader",
  album: "远端测试视频",
  durationMs: 60_000,
  availability: "unknown",
  video: { title: "远端测试视频", partTitle: "第一 P", partNumber: 1 },
};

const part2: ProviderTrack = {
  ...part1,
  id: "bilibili:video:BV17x411w7KC:124",
  title: "分 P 二",
  video: { title: "远端测试视频", partTitle: "第二 P", partNumber: 2 },
};

const playlist: ProviderContainer = {
  providerId: "netease",
  id: "netease:playlist:9",
  kind: "playlist",
  ownership: "created",
  owner: { providerId: "netease", id: "u-1" },
  title: "远端自建歌单",
  description: "描述",
  itemCount: 2,
  allowedActions: [],
};

const page = <T,>(items: T[], hasMore = false, n = 1, total = items.length): ProviderPage<T> => ({
  page: n,
  total,
  hasMore,
  items,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.nativeProviderStatus).mockImplementation(async id => readySnapshot(id as NewProviderId));
  vi.mocked(api.nativeProviderLibraryLikes).mockResolvedValue(page([track1, track2]));
  const bilibiliFolder: ProviderContainer = {
    providerId: "bilibili",
    id: "bilibili:favorite:7",
    kind: "favoriteFolder",
    ownership: "created",
    owner: { providerId: "bilibili", id: "u-1" },
    title: "自建收藏夹",
    description: "",
    itemCount: 1,
    allowedActions: [],
  };
  vi.mocked(api.nativeProviderLibraryContainers).mockImplementation(async id =>
    page([id === "bilibili" ? bilibiliFolder : playlist]),
  );
  vi.mocked(api.nativeProviderContainer).mockResolvedValue(playlist);
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([track1, track2]));
  vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([video1]));
  vi.mocked(api.nativeProviderSearchSongs).mockResolvedValue(page([track1]));
  vi.mocked(api.nativeProviderSearchPlaylists).mockResolvedValue(page([playlist]));
  vi.mocked(api.nativeProviderSearchVideos).mockResolvedValue(page([video1]));
  vi.mocked(api.nativeProviderResolveVideo).mockResolvedValue(video1);
  vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([part1]));
  vi.mocked(api.nativeProviderEnqueueTrack).mockResolvedValue({
    generation: 1,
    selectedIndex: 0,
    items: [api.providerTrackToQueueTrack(track1)],
  });
  vi.mocked(api.nativeProviderEnqueueTracks).mockImplementation(async tracks => ({
    generation: 2,
    selectedIndex: 0,
    items: tracks.map(api.providerTrackToQueueTrack),
  }));
  vi.mocked(nativeQueueReplace).mockImplementation(async items => ({
    generation: 3,
    selectedIndex: 0,
    items,
  }));
  vi.mocked(nativeQueueEnqueueNext).mockResolvedValue({
    generation: 1,
    selectedIndex: 0,
    items: [api.providerTrackToQueueTrack(track1)],
  });
  vi.mocked(playerActions.playTrack).mockResolvedValue(true);
  vi.mocked(playerActions.hydrateNative).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetPlayerFixture();
});

describe("RemoteProviderLibrary parity & safety", () => {
  it("U01 & F04: renders per-row trigger/next/enqueue buttons without native title and never fakes playback success when playTrack returns false", async () => {
    vi.mocked(playerActions.playTrack).mockResolvedValueOnce(false);
    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);

    await screen.findByText("远端歌曲一");
    const row = screen.getByText("远端歌曲一").closest("tr")!;
    const playBtn = within(row).getByRole("button", { name: "播放 远端歌曲一" });
    const nextBtn = within(row).getByRole("button", { name: "下一首播放 远端歌曲一" });
    const addBtn = within(row).getByRole("button", { name: "加入队列 远端歌曲一" });
    expect(playBtn).toBeEnabled();
    expect(nextBtn).toBeEnabled();
    expect(addBtn).toBeEnabled();
    expect(playBtn).not.toHaveAttribute("title");
    expect(nextBtn).not.toHaveAttribute("title");
    expect(addBtn).not.toHaveAttribute("title");

    fireEvent.click(playBtn);
    await screen.findByText("已加入队列，但未能启动播放：远端歌曲一");
    expect(screen.queryByText(/正在播放/)).not.toBeInTheDocument();
    expect(screen.queryByText(/正在电脑播放/)).not.toBeInTheDocument();
  });

  it("F03: NetEase likes and playlist expose distinct play-all and enqueue-all actions with >1000 truncation protection", async () => {
    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲一");

    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([track1, track2]));
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(track1.id));

    fireEvent.click(screen.getByRole("button", { name: "创建的歌单" }));
    await screen.findByText("远端自建歌单");
    fireEvent.click(screen.getByRole("button", { name: "查看曲目" }));
    await screen.findByRole("button", { name: "返回歌单列表" });
    expect(screen.getByRole("button", { name: "播放全部" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "全部加入队列" })).toBeEnabled();
  });

  it("F02 & F03: Bilibili single-P video plays/enqueues directly while multi-P expands to picker and exposes play-all parts", async () => {
    const view = render(<RemoteProviderLibrary providerId="bilibili" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("自建收藏夹");
    fireEvent.click(screen.getByRole("button", { name: "搜索 / BV 解析" }));
    const searchInput = await screen.findByRole("searchbox", { name: "搜索 Bilibili 视频或输入 BV/AV 号" });
    fireEvent.change(searchInput, { target: { value: "测试" } });
    fireEvent.submit(searchInput.closest("form")!);
    await screen.findByText("远端测试视频");

    const row = screen.getByText("远端测试视频").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "加入队列 远端测试视频" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTrack).toHaveBeenCalledWith(part1));
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([part1, part2]));
    fireEvent.click(within(row).getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    await screen.findByText("P2 · 第二 P");
    await screen.findByText(/该视频包含多个分 P/);
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    const playAllPartsBtn = screen.getByRole("button", { name: "播放全部分 P" });
    fireEvent.click(playAllPartsBtn);
    await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledWith([part1, part2].map(api.providerTrackToQueueTrack)));
    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(part1.id));

    view.unmount();
  });

  it("F08 & U09 & U12: disables unavailable items, avoids 在线 as quality, and cancels in-flight actions on view switch", async () => {
    const blockedTrack: ProviderTrack = { ...track2, availability: "authenticationRequired" };
    vi.mocked(api.nativeProviderLibraryLikes).mockResolvedValue(page([track1, blockedTrack]));
    const pendingGate = deferred<Awaited<ReturnType<typeof api.nativeProviderEnqueueTrack>>>();
    vi.mocked(api.nativeProviderEnqueueTrack).mockReturnValueOnce(pendingGate.promise);

    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲二");

    const blockedRow = screen.getByText("远端歌曲二").closest("tr")!;
    expect(within(blockedRow).getByRole("button", { name: "播放 远端歌曲二" })).toBeDisabled();
    expect(within(blockedRow).getByRole("button", { name: "加入队列 远端歌曲二" })).toBeDisabled();
    expect(screen.getByText(/需要登录/)).toBeInTheDocument();
    expect(screen.queryByText("在线")).not.toBeInTheDocument();

    const okRow = screen.getByText("远端歌曲一").closest("tr")!;
    fireEvent.click(within(okRow).getByRole("button", { name: "播放 远端歌曲一" }));
    fireEvent.click(screen.getByRole("button", { name: "创建的歌单" }));
    await screen.findByText("远端自建歌单");

    await act(async () => {
      pendingGate.resolve({
        generation: 5,
        selectedIndex: 0,
        items: [api.providerTrackToQueueTrack(track1)],
      });
    });
    expect(playerActions.playTrack).not.toHaveBeenCalled();
  });

  it("F02: Bilibili folder detail exposes play-all / enqueue-all P1 (absent in search), respects playTrack false, and keeps queue unchanged on parts failure", async () => {
    const videoB: ProviderVideo = {
      ...video1,
      bvid: "BV1999999999",
      aid: "170002",
      title: "第二个可播视频",
    };
    const blockedVideo: ProviderVideo = {
      ...video1,
      bvid: "BV1deleted00",
      aid: "170003",
      title: "已失效视频",
      availability: "deleted",
    };
    const partB1: ProviderTrack = {
      ...part1,
      id: "bilibili:video:BV1999999999:201",
      title: "视频二第一 P",
      video: { title: "第二个可播视频", partTitle: "P1", partNumber: 1 },
    };
    const partB2: ProviderTrack = {
      ...partB1,
      id: "bilibili:video:BV1999999999:202",
      title: "视频二第二 P",
      video: { title: "第二个可播视频", partTitle: "P2", partNumber: 2 },
    };

    const bilibiliFolder: ProviderContainer = {
      providerId: "bilibili",
      id: "bilibili:favorite:7",
      kind: "favoriteFolder",
      ownership: "created",
      owner: { providerId: "bilibili", id: "u-1" },
      title: "自建收藏夹",
      description: "",
      itemCount: 3,
      allowedActions: [],
    };
    vi.mocked(api.nativeProviderContainer).mockResolvedValue(bilibiliFolder);

    const view = render(<RemoteProviderLibrary providerId="bilibili" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("自建收藏夹");

    // 搜索视频结果视图不应出现整收藏夹按钮
    fireEvent.click(screen.getByRole("button", { name: "搜索 / BV 解析" }));
    const searchInput = await screen.findByRole("searchbox", { name: "搜索 Bilibili 视频或输入 BV/AV 号" });
    fireEvent.change(searchInput, { target: { value: "测试" } });
    fireEvent.submit(searchInput.closest("form")!);
    await screen.findByText("远端测试视频");
    expect(screen.queryByRole("button", { name: "播放全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全部加入队列" })).not.toBeInTheDocument();

    // 切回收藏夹列表，先验证空收藏夹时按钮禁用
    vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([]));
    fireEvent.click(screen.getByRole("button", { name: "创建的收藏夹" }));
    await screen.findByText("自建收藏夹");
    fireEvent.click(screen.getByRole("button", { name: "查看视频" }));
    await screen.findByText("收藏夹暂无视频");
    expect(screen.getByRole("button", { name: "播放全部" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部加入队列" })).toBeDisabled();

    // 重新进入含有效/失效视频的收藏夹详情
    fireEvent.click(screen.getByRole("button", { name: "返回收藏夹列表" }));
    await screen.findByText("自建收藏夹");
    vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([video1, blockedVideo, videoB]));
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (bvid) => {
      if (bvid === video1.bvid) return page([part1, part2]);
      if (bvid === videoB.bvid) return page([partB1, partB2]);
      return page([]);
    });
    fireEvent.click(screen.getByRole("button", { name: "查看视频" }));
    await screen.findByText("第二个可播视频");

    // 全部加入队列：仅为可播放视频取 P1，跳过不可用视频，不调用 playTrack
    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([part1, partB1]));
    expect(api.nativeProviderVideoParts).toHaveBeenCalledTimes(2);
    expect(api.nativeProviderVideoParts).not.toHaveBeenCalledWith(blockedVideo.bvid, expect.anything(), expect.anything());
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    await screen.findByText("已加入队列（2 首）（跳过 1 个不可用条目）");

    // 播放全部：检查 playTrack 返回 false 时不误报播放成功
    vi.mocked(playerActions.playTrack).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith([part1, partB1].map(api.providerTrackToQueueTrack)));
    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(part1.id));
    await screen.findByText("已替换队列（2 首），但未能启动播放：分 P 一（跳过 1 个不可用条目）");
    expect(screen.queryByText(/已替换队列并播放/)).not.toBeInTheDocument();

    // 某视频 video.parts 失败时中止且不修改队列
    vi.clearAllMocks();
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (bvid) => {
      if (bvid === video1.bvid) return page([part1]);
      throw new api.ProviderAdapterError("QMG-PROVIDER-001", "provider_unavailable");
    });
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText("当前来源正在恢复或暂不可用，请稍后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.hydrateNative).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    view.unmount();
  });

  it("F06: truncates NetEase playlist (>1000 tracks) and Bilibili multi-P (>1000 parts) to first 1000 items with clear notice", async () => {
    const allTracks: ProviderTrack[] = Array.from({ length: 1001 }, (_, idx) => ({
      ...track1,
      id: `netease:track:${idx + 1}`,
      title: `歌曲 ${idx + 1}`,
    }));
    vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_provider, _id, p = 1, size = 50) => {
      const start = (p - 1) * size;
      const slice = allTracks.slice(start, start + size);
      return page(slice, start + size < allTracks.length, p, allTracks.length);
    });

    const neteaseView = render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲一");
    fireEvent.click(screen.getByRole("button", { name: "创建的歌单" }));
    await screen.findByText("远端自建歌单");
    fireEvent.click(screen.getByRole("button", { name: "查看曲目" }));
    await screen.findByText("歌曲 1");

    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledTimes(1));
    const enqueuedTracks = vi.mocked(api.nativeProviderEnqueueTracks).mock.calls[0]![0];
    expect(enqueuedTracks).toHaveLength(1000);
    expect(enqueuedTracks[0]!.id).toBe("netease:track:1");
    expect(enqueuedTracks[999]!.id).toBe("netease:track:1000");
    await screen.findByText("已加入队列（1000 首）（已截取前 1000 首）");
    neteaseView.unmount();

    vi.clearAllMocks();
    vi.mocked(api.nativeProviderStatus).mockImplementation(async id => readySnapshot(id as NewProviderId));
    const bilibiliFolder: ProviderContainer = {
      providerId: "bilibili",
      id: "bilibili:favorite:7",
      kind: "favoriteFolder",
      ownership: "created",
      owner: { providerId: "bilibili", id: "u-1" },
      title: "自建收藏夹",
      description: "",
      itemCount: 1,
      allowedActions: [],
    };
    vi.mocked(api.nativeProviderLibraryContainers).mockResolvedValue(page([bilibiliFolder]));
    vi.mocked(api.nativeProviderContainer).mockResolvedValue(bilibiliFolder);
    vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([video1]));
    const allParts: ProviderTrack[] = Array.from({ length: 1001 }, (_, idx) => ({
      ...part1,
      id: `bilibili:video:${video1.bvid}:${idx + 1}`,
      title: `分 P ${idx + 1}`,
      video: { title: video1.title, partTitle: `第 ${idx + 1} P`, partNumber: idx + 1 },
    }));
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (_bvid, p = 1, size = 100) => {
      const start = (p - 1) * size;
      const slice = allParts.slice(start, start + size);
      return page(slice, start + size < allParts.length, p, allParts.length);
    });
    vi.mocked(nativeQueueReplace).mockImplementation(async items => ({
      generation: 3,
      selectedIndex: 0,
      items,
    }));
    vi.mocked(playerActions.playTrack).mockResolvedValue(true);
    vi.mocked(playerActions.hydrateNative).mockResolvedValue();

    const bilibiliView = render(<RemoteProviderLibrary providerId="bilibili" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("自建收藏夹");
    fireEvent.click(screen.getByRole("button", { name: "查看视频" }));
    await screen.findByText("远端测试视频");
    fireEvent.click(screen.getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    await screen.findByText("P1 · 第 1 P");

    fireEvent.click(screen.getByRole("button", { name: "播放全部分 P" }));
    await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledTimes(1));
    const replacedItems = vi.mocked(nativeQueueReplace).mock.calls[0]![0];
    expect(replacedItems).toHaveLength(1000);
    expect(replacedItems[0]!.id).toBe(`bilibili:video:${video1.bvid}:1`);
    expect(replacedItems[999]!.id).toBe(`bilibili:video:${video1.bvid}:1000`);
    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(`bilibili:video:${video1.bvid}:1`));
    await screen.findByText("已替换队列并播放：分 P 1（共 1000 首）（已截取前 1000 首）");
    bilibiliView.unmount();
  });

  it("Comment #1: aborts NetEase full-batch playback/enqueue on incomplete pages without mutating queue", async () => {
    const allTracks: ProviderTrack[] = Array.from({ length: 120 }, (_, idx) => ({
      ...track1,
      id: `netease:track:${idx + 1}`,
      title: `歌曲 ${idx + 1}`,
    }));
    let page2Response: ProviderPage<ProviderTrack> = {
      page: 2,
      total: 120,
      hasMore: true,
      items: [],
    };
    vi.mocked(api.nativeProviderLibraryLikes).mockImplementation(async (_provider, p = 1, size = 20) => {
      if (p === 1) {
        return page(allTracks.slice(0, size), true, 1, 120);
      }
      return page2Response;
    });

    const view = render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("歌曲 1");

    // 1. empty_page on page 2 (hasMore: true, items: []) -> "播放全部"
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText("列表读取不完整，队列未修改；请刷新后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.hydrateNative).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    // 2. empty_page on page 2 -> "全部加入队列"
    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await screen.findByText("列表读取不完整，队列未修改；请刷新后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    // 3. total_mismatch
    page2Response = {
      page: 2,
      total: 90,
      hasMore: false,
      items: allTracks.slice(50, 90),
    };
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText("列表读取不完整，队列未修改；请刷新后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    // 4. page_mismatch
    page2Response = {
      page: 1,
      total: 120,
      hasMore: true,
      items: allTracks.slice(50, 100),
    };
    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await screen.findByText("列表读取不完整，队列未修改；请刷新后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    // 5. short_read (hasMore: false, total: 120, only 60 items returned)
    page2Response = {
      page: 2,
      total: 120,
      hasMore: false,
      items: allTracks.slice(50, 60),
    };
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText("列表读取不完整，队列未修改；请刷新后重试");
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.hydrateNative).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();

    view.unmount();
  });

  it("Comment #3: search resubmit, new search, BV resolve, and searchKind switch invalidate in-flight actions immediately", async () => {
    const newVideo: ProviderVideo = {
      ...video1,
      bvid: "BV1newSearch1",
      aid: "170099",
      title: "新搜索视频",
    };
    const resolvedVideo: ProviderVideo = {
      ...video1,
      bvid: "BV1resolved1",
      aid: "170100",
      title: "解析出的视频",
    };
    const resolvedParts = page([part1, part2]);

    const pendingParts1 = deferred<ProviderPage<ProviderTrack>>();
    const pendingParts2 = deferred<ProviderPage<ProviderTrack>>();
    const pendingParts3 = deferred<ProviderPage<ProviderTrack>>();
    let callIdx = 0;
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (bvid) => {
      if (bvid === resolvedVideo.bvid) return resolvedParts;
      callIdx += 1;
      if (callIdx === 1) return pendingParts1.promise;
      if (callIdx === 2) return pendingParts2.promise;
      return pendingParts3.promise;
    });
    vi.mocked(api.nativeProviderSearchVideos).mockImplementation(async (kw) =>
      page([kw === "新词" ? newVideo : video1]),
    );
    vi.mocked(api.nativeProviderResolveVideo).mockResolvedValue(resolvedVideo);

    const bilibiliView = render(
      <RemoteProviderLibrary providerId="bilibili" initialTab="search" onBack={vi.fn()} onSelectSource={vi.fn()} />,
    );
    const searchInput = await screen.findByRole("searchbox", { name: "搜索 Bilibili 视频或输入 BV/AV 号" });
    fireEvent.change(searchInput, { target: { value: "旧词" } });
    fireEvent.submit(searchInput.closest("form")!);
    await screen.findByText("远端测试视频");

    // 1. Click play on old search result (nativeProviderVideoParts in flight), then immediately re-submit the SAME keyword
    const oldRow = screen.getByText("远端测试视频").closest("tr")!;
    fireEvent.click(within(oldRow).getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    expect(screen.getByText(`正在读取视频分 P：${video1.title}…`)).toBeInTheDocument();

    fireEvent.submit(searchInput.closest("form")!);
    expect(screen.queryByText(/正在读取视频分 P/)).not.toBeInTheDocument();
    await act(async () => {
      pendingParts1.resolve(page([part1]));
    });
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTrack).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在播放/)).not.toBeInTheDocument();

    // 2. Click play on old search result again, then immediately submit a NEW search keyword
    fireEvent.click(within(oldRow).getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    expect(screen.getByText(`正在读取视频分 P：${video1.title}…`)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "新词" } });
    fireEvent.submit(searchInput.closest("form")!);
    await screen.findByText("新搜索视频");
    expect(screen.queryByText(/正在读取视频分 P/)).not.toBeInTheDocument();

    await act(async () => {
      pendingParts2.resolve(page([part1]));
    });
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTrack).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在播放/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已加入队列/)).not.toBeInTheDocument();

    // 3. Click play on new search result, then immediately resolve a BV input
    const newRow = screen.getByText("新搜索视频").closest("tr")!;
    fireEvent.click(within(newRow).getByRole("button", { name: "播放或展开分 P 新搜索视频" }));
    expect(screen.getByText(`正在读取视频分 P：${newVideo.title}…`)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: resolvedVideo.bvid } });
    fireEvent.click(screen.getByRole("button", { name: "解析 BV/AV 并展开分 P" }));
    await screen.findByText("P2 · 第二 P");

    await act(async () => {
      pendingParts3.resolve(page([part1]));
    });
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTrack).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在播放/)).not.toBeInTheDocument();
    bilibiliView.unmount();

    // 3. NetEase searchKind switch invalidates in-flight enqueue/play immediately
    vi.clearAllMocks();
    vi.mocked(api.nativeProviderStatus).mockImplementation(async id => readySnapshot(id as NewProviderId));
    vi.mocked(api.nativeProviderSearchSongs).mockResolvedValue(page([track1]));
    vi.mocked(api.nativeProviderSearchPlaylists).mockResolvedValue(page([playlist]));
    const pendingEnqueue = deferred<Awaited<ReturnType<typeof api.nativeProviderEnqueueTrack>>>();
    vi.mocked(api.nativeProviderEnqueueTrack).mockReturnValueOnce(pendingEnqueue.promise);

    const neteaseView = render(
      <RemoteProviderLibrary providerId="netease" initialTab="search" onBack={vi.fn()} onSelectSource={vi.fn()} />,
    );
    const neteaseInput = await screen.findByRole("searchbox", { name: "搜索网易云歌曲或歌单" });
    fireEvent.change(neteaseInput, { target: { value: "测试歌" } });
    fireEvent.submit(neteaseInput.closest("form")!);
    await screen.findByText("远端歌曲一");

    const songRow = screen.getByText("远端歌曲一").closest("tr")!;
    fireEvent.click(within(songRow).getByRole("button", { name: "播放 远端歌曲一" }));
    fireEvent.click(screen.getByRole("button", { name: "歌单" }));
    await screen.findByText("远端自建歌单");

    await act(async () => {
      pendingEnqueue.resolve({
        generation: 9,
        selectedIndex: 0,
        items: [api.providerTrackToQueueTrack(track1)],
      });
    });
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(playerActions.hydrateNative).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在播放/)).not.toBeInTheDocument();
    neteaseView.unmount();
  });

  it.each(["first_page_empty", "last_page_empty"] as const)(
    "P2 regression: Remote Bilibili folder succeeds batch enqueue/play and pagination when %s after filtering",
    async scenario => {
      const validVideo: ProviderVideo = {
        ...video1,
        bvid: "BV17x411w7KH",
        aid: "170088",
        title: "Remote 过滤幸存视频",
      };
      const validPart: ProviderTrack = {
        ...part1,
        id: "bilibili:video:BV17x411w7KH:801",
        title: "Remote 幸存分 P1",
        video: { title: validVideo.title, partTitle: "P1", partNumber: 1 },
      };
      const bilibiliFolder: ProviderContainer = {
        providerId: "bilibili",
        id: "bilibili:favorite:7",
        kind: "favoriteFolder",
        ownership: "created",
        owner: { providerId: "bilibili", id: "u-1" },
        title: "自建收藏夹",
        description: "",
        itemCount: 21,
        allowedActions: [],
      };
      vi.mocked(api.nativeProviderContainer).mockResolvedValue(bilibiliFolder);
      vi.mocked(api.nativeProviderLibraryVideos).mockImplementation(async (_containerId, p = 1) => {
        if (scenario === "first_page_empty") {
          return p === 1
            ? { page: 1, total: 21, hasMore: true, items: [] }
            : { page: 2, total: 21, hasMore: false, items: [validVideo] };
        }
        return p === 1
          ? { page: 1, total: 21, hasMore: true, items: [validVideo] }
          : { page: 2, total: 21, hasMore: false, items: [] };
      });
      vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([validPart]));
      vi.mocked(nativeQueueReplace).mockImplementation(async items => ({
        generation: 4,
        selectedIndex: 0,
        items,
      }));
      vi.mocked(playerActions.playTrack).mockResolvedValue(true);

      const view = render(<RemoteProviderLibrary providerId="bilibili" onBack={vi.fn()} onSelectSource={vi.fn()} />);
      await screen.findByText("自建收藏夹");
      fireEvent.click(screen.getByRole("button", { name: "查看视频" }));

      if (scenario === "first_page_empty") {
        await screen.findByText("收藏夹暂无视频");
        expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
      } else {
        await screen.findByText(validVideo.title);
      }

      const playAll = screen.getByRole("button", { name: "播放全部" });
      const enqueueAll = screen.getByRole("button", { name: "全部加入队列" });
      expect(playAll).toBeEnabled();
      expect(enqueueAll).toBeEnabled();

      fireEvent.click(enqueueAll);
      await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([validPart]));
      expect(nativeQueueReplace).not.toHaveBeenCalled();
      expect(playerActions.playTrack).not.toHaveBeenCalled();

      if (scenario === "last_page_empty") {
        fireEvent.click(screen.getByRole("button", { name: "下一页" }));
        await screen.findByText("收藏夹暂无视频");
        expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "播放全部" })).toBeEnabled();
      }

      fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
      await waitFor(() =>
        expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith([api.providerTrackToQueueTrack(validPart)]),
      );
      await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(validPart.id));
      expect(screen.queryByText(/列表读取不完整/)).not.toBeInTheDocument();
      view.unmount();
    },
  );

  it("P2-02 (1): clicking track row trigger plays and shows 5s toast that auto-dismisses, and omits toast when playTrack returns false", async () => {
    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲一");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rowTrigger = screen.getByRole("button", { name: "播放 远端歌曲一" });
    fireEvent.click(rowTrigger);
    await screen.findByText("正在电脑播放《远端歌曲一》");
    expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(track1.id);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("正在电脑播放《远端歌曲一》")).not.toBeInTheDocument();

    vi.mocked(playerActions.playTrack).mockResolvedValueOnce(false);
    fireEvent.click(rowTrigger);
    await screen.findByText("已加入队列，但未能启动播放：远端歌曲一");
    expect(screen.queryByText(/正在电脑播放/)).not.toBeInTheDocument();
  });

  it("P2-02 (2): pointermove exceeding 10px cancels row click to prevent accidental playback during scroll", async () => {
    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲一");

    const rowTrigger = screen.getByRole("button", { name: "播放 远端歌曲一" });
    fireEvent.pointerDown(rowTrigger, { clientX: 120, clientY: 200 });
    fireEvent.pointerMove(rowTrigger, { clientX: 120, clientY: 215 });
    fireEvent.pointerUp(rowTrigger, { clientX: 120, clientY: 215 });
    fireEvent.click(rowTrigger);

    expect(api.nativeProviderEnqueueTrack).not.toHaveBeenCalled();
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在电脑播放/)).not.toBeInTheDocument();

    // Small movement within 10px still triggers playback
    fireEvent.pointerDown(rowTrigger, { clientX: 120, clientY: 200 });
    fireEvent.pointerMove(rowTrigger, { clientX: 123, clientY: 204 });
    fireEvent.pointerUp(rowTrigger, { clientX: 123, clientY: 204 });
    fireEvent.click(rowTrigger);

    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(track1.id));
  });

  it("P2-02 (3): clicking undo on toast restores previous track when it exists in queue", async () => {
    act(() => {
      playerActions.applyAuthoritativeSession({
        requestedQuality: "320k",
        mode: "sequence",
        queue: {
          generation: 10,
          selectedIndex: 0,
          items: [
            { id: "prev-1", title: "上一首老歌", artist: "歌手 X", album: "", durationMs: 150_000 },
            api.providerTrackToQueueTrack(track1),
          ],
        },
        player: {
          state: "playing",
          generation: 10,
          currentTrack: { id: "prev-1", title: "上一首老歌", artist: "歌手 X" },
          positionMs: 10_000,
          durationMs: 150_000,
          volume: 0.7,
          muted: false,
          failure: null,
        },
      });
    });

    render(<RemoteProviderLibrary providerId="netease" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    await screen.findByText("远端歌曲一");

    fireEvent.click(screen.getByRole("button", { name: "播放 远端歌曲一" }));
    await screen.findByText("正在电脑播放《远端歌曲一》");

    const undoButton = screen.getByRole("button", { name: "撤销" });
    fireEvent.click(undoButton);

    await waitFor(() => expect(playerActions.playTrack).toHaveBeenLastCalledWith("prev-1"));
    await screen.findByText("已切回《上一首老歌》");
    expect(screen.queryByText("正在电脑播放《远端歌曲一》")).not.toBeInTheDocument();
  });

  it("P2-02 (4): multi-P Bilibili row trigger only expands parts without playing, while single-P plays immediately and shows toast", async () => {
    render(<RemoteProviderLibrary providerId="bilibili" initialTab="search" onBack={vi.fn()} onSelectSource={vi.fn()} />);
    const searchInput = await screen.findByRole("searchbox", { name: "搜索 Bilibili 视频或输入 BV/AV 号" });
    fireEvent.change(searchInput, { target: { value: "测试" } });
    fireEvent.submit(searchInput.closest("form")!);
    await screen.findByText("远端测试视频");

    // Multi-P video: clicking row expands parts picker without playing
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValueOnce(page([part1, part2]));
    fireEvent.click(screen.getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    await screen.findByText("P2 · 第二 P");
    expect(playerActions.playTrack).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在电脑播放/)).not.toBeInTheDocument();

    // Return to search result and test single-P video: clicking row plays immediately with toast
    fireEvent.click(screen.getByRole("button", { name: "返回视频列表" }));
    await screen.findByText("远端测试视频");

    vi.mocked(api.nativeProviderVideoParts).mockResolvedValueOnce(page([part1]));
    fireEvent.click(screen.getByRole("button", { name: "播放或展开分 P 远端测试视频" }));
    await waitFor(() => expect(playerActions.playTrack).toHaveBeenCalledExactlyOnceWith(part1.id));
    await screen.findByText("正在电脑播放《分 P 一》");
  });
});
