import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invalidatePlaylistSongs } from "./readPlaylistSongs";
import LibraryWorkspace from "./LibraryWorkspace";
import { resetPlayerFixture } from "../player/playerStore";
import type { AuthSnapshot } from "../../contracts/auth";
import type { ProviderContainer, ProviderPage, ProviderSnapshot, ProviderTrack } from "../../contracts/providers";
import constants from "../../../contracts/protocol-v2.constants.json";
import { DesktopProviders } from "../providers/DesktopProviders";
import * as providers from "../../backend/providersAdapter";

const {
  discoverMock,
  searchMock,
  playlistSongsMock,
  playlistsMock,
  likedMock,
  enqueueMock,
  enqueueManyMock,
  replaceMock,
  playMock,
  addToPlaylistMock,
  setLikedMock,
} = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  searchMock: vi.fn(),
  playlistSongsMock: vi.fn(),
  playlistsMock: vi.fn(),
  likedMock: vi.fn(),
  enqueueMock: vi.fn(),
  enqueueManyMock: vi.fn(),
  replaceMock: vi.fn(),
  playMock: vi.fn(),
  addToPlaylistMock: vi.fn(),
  setLikedMock: vi.fn(),
}));

vi.mock("../../backend/libraryAdapter", () => ({
  getLibraryPlaylists: playlistsMock,
  getLikedSongs: likedMock,
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongsToPlaylist: addToPlaylistMock,
  setPlaylistFavorite: vi.fn(),
  setSongsLiked: setLikedMock,
}));

vi.mock("../../backend/catalogAdapter", () => ({
  discoverCatalogSongs: discoverMock,
  searchCatalogSongs: searchMock,
  getPlaylistSongs: playlistSongsMock,
}));
vi.mock("../../backend/providersAdapter", async original => ({
  ...await original<typeof import("../../backend/providersAdapter")>(),
  nativeProviderStatus: vi.fn(),
  nativeProviderLibraryLikes: vi.fn(),
  nativeProviderLibraryContainers: vi.fn(),
}));
vi.mock("../artist/ArtistPage", () => ({
  ArtistPage: ({ artist, onBack }: { artist: { id: string; name: string }; onBack: () => void }) => (
    <section>
      <h1>{artist.name} · ARTIST</h1>
      <button onClick={onBack} type="button">返回上一页</button>
    </section>
  ),
}));
vi.mock("../../backend/nativeQueueAdapter", () => ({
  nativeQueueEnqueue: enqueueMock,
  nativeQueueEnqueueMany: enqueueManyMock,
  nativeQueueReplace: replaceMock,
  nativeQueuePlay: playMock,
  nativeQueueSnapshot: vi.fn(),
  nativeQueueMove: vi.fn(),
  nativeQueueRemove: vi.fn(),
  nativeQueueNext: vi.fn(),
  nativeQueuePrevious: vi.fn(),
  nativePlaybackSessionSnapshot: vi.fn(),
  nativeSetPlaybackMode: vi.fn(),
}));
vi.mock("../../backend/nativePlayerAdapter", () => ({
  PlayerAdapterError: class PlayerAdapterError extends Error {},
  nativePlayerSnapshot: vi.fn().mockResolvedValue({
    state: "idle", generation: 0, positionMs: 0, durationMs: null,
    volume: 0.72, muted: false, currentTrack: null, failure: null,
  }),
  nativePlay: vi.fn(),
  nativePause: vi.fn(),
  nativeSeek: vi.fn(),
  nativeSetMuted: vi.fn(),
  nativeSetVolume: vi.fn(),
  nativeStop: vi.fn(),
}));

const SONG = {
  id: "0039MnYb0qxYhV", title: "晴天", subtitle: "",
  artists: [{ id: "artist-mid-jay", name: "周杰伦" }], artist: "周杰伦", album: "叶惠美",
  durationMs: 269_000,
  qualityCandidates: [
    { quality: "flac", available: true, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: true },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: true },
} as const;
const SONG_TWO = { ...SONG, id: "0039MnYb0qxYhV-2", title: "夜曲" } as const;
const PAGE = { generation: 1, page: 1, hasMore: false, warningCount: 0, items: [SONG] };
const AUTHENTICATED = {
  state: "authenticated",
  account: { musicId: "779436361", loginMethod: "qq" },
} as const;

function renderWorkspace(
  initialSection: "discover" | "search" | "liked" | "playlists" = "discover",
  authSnapshot: AuthSnapshot = AUTHENTICATED,
  authRecovering = false,
) {
  return render(
    <LibraryWorkspace
      authRecovering={authRecovering}
      authSnapshot={authSnapshot}
      initialSection={initialSection}
      onBack={() => undefined}
    />,
  );
}

describe("live catalog workspace", () => {
it.each(["discover", "search"] as const)("gates the %s online view through signed-out, restoring and ready", async section => {
  const view=renderWorkspace(section,{state:"signedOut"});
  expect(screen.getByText("请先登录后搜索或发现音乐")).toBeInTheDocument();
  if(section==="search")await userEvent.type(screen.getByRole("combobox"),"待恢复");
  await new Promise(resolve=>setTimeout(resolve,350));
  expect(discoverMock).not.toHaveBeenCalled();expect(searchMock).not.toHaveBeenCalled();expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.rerender(<LibraryWorkspace authSnapshot={{state:"signedOut"}} authRecovering initialSection={section} onBack={()=>{}} />);
  expect(screen.getByText("正在恢复账号")).toBeInTheDocument();
  await new Promise(resolve=>setTimeout(resolve,350));expect(discoverMock).not.toHaveBeenCalled();expect(searchMock).not.toHaveBeenCalled();
  view.rerender(<LibraryWorkspace authSnapshot={AUTHENTICATED} authRecovering={false} initialSection={section} onBack={()=>{}} />);
  await screen.findAllByText(SONG.title);
  expect(section==="discover"?discoverMock:searchMock).toHaveBeenCalledOnce();
});

  beforeEach(() => {
    setLikedMock.mockReset().mockResolvedValue({ status: "applied" });
    invalidatePlaylistSongs();
    enqueueManyMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    discoverMock.mockReset().mockResolvedValue(PAGE);
    searchMock.mockReset().mockImplementation((_keyword: string, generation: number) =>
      Promise.resolve({ ...PAGE, generation }),
    );
    playlistSongsMock.mockReset().mockImplementation((_id: string, generation: number) =>
      Promise.resolve({ ...PAGE, generation }),
    );
    likedMock.mockReset().mockImplementation((_page: number, pageSize: number, generation: number) =>
      Promise.resolve({ ...PAGE, generation, pageSize }),
    );
    playlistsMock.mockReset().mockImplementation((kind: "created" | "favorite") => Promise.resolve({
      kind, page: 1, hasMore: false, total: kind === "created" ? 1 : 0, warningCount: 0,
      items: kind === "created" ? [{
        id: "99123456", editableId: "88", title: "我喜欢", songCount: 11,
      }] : [],
    }));
    enqueueMock.mockReset().mockResolvedValue({
      generation: 1, selectedIndex: 0,
      items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }],
    });
    replaceMock.mockReset().mockResolvedValue({
      generation: 2,
      selectedIndex: 0,
      items: [
        { id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs },
        { id: SONG_TWO.id, title: SONG_TWO.title, artist: SONG_TWO.artist, album: SONG_TWO.album, durationMs: SONG_TWO.durationMs },
      ],
    });
    playMock.mockReset().mockResolvedValue({
      queue: {
        generation: 2, selectedIndex: 0,
        items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }],
      },
      playback: {
        quality: "128k",
        expiresInSeconds: 300,
        player: {
          state: "playing", generation: 7, positionMs: 0, durationMs: SONG.durationMs,
          volume: 0.72, muted: false,
          currentTrack: { id: SONG.id, title: SONG.title, artist: SONG.artist },
          failure: null,
        },
      },
    });
    addToPlaylistMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    resetPlayerFixture();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("桌面喜欢页取消喜欢后读回列表，提交失败不自动重放", async () => {
    const user = userEvent.setup();
    renderWorkspace("liked", { state: "authenticated" });
    const unlike = await screen.findByRole("button", { name: "取消喜欢" });
    await user.click(unlike);
    expect(setLikedMock).toHaveBeenCalledExactlyOnceWith([SONG.id], false);
    await waitFor(() => expect(likedMock).toHaveBeenCalledTimes(2));
    setLikedMock.mockRejectedValueOnce(new Error("uncertain write"));
    await user.click(screen.getByRole("button", { name: "取消喜欢" }));
    expect(await screen.findByText("喜欢状态待核对；应用没有自动重复提交")).toBeInTheDocument();
    expect(setLikedMock).toHaveBeenCalledTimes(2);
    expect(likedMock).toHaveBeenCalledTimes(2);
  });

  it("Tauri 窗口读取真实发现页且不显示 fixture 曲目", async () => {
    renderWorkspace();
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("周杰伦").length).toBeGreaterThan(0);
    expect(screen.queryByText("暮色温室")).not.toBeInTheDocument();
    expect(screen.getByText("QQ / LIVE")).toBeInTheDocument();
  });

  it("搜索去抖后只保留新 generation，并可加入后交给原生播放器", async () => {
    const user = userEvent.setup();
    renderWorkspace("search");
    await user.type(screen.getByRole("combobox"), "晴天");
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(searchMock).toHaveBeenCalledWith("晴天", expect.any(Number), 1);

    await user.click(screen.getByRole("button", { name: "原生播放" }));
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled());
    expect(playMock).toHaveBeenCalledWith(SONG.id, 1);
    expect(await screen.findByText("已交给 Windows 原生播放器")).toBeInTheDocument();
  });

  it("从真实歌单卡片打开详情并返回列表", async () => {
    const user = userEvent.setup();
    renderWorkspace("playlists");
    expect(await screen.findByText("我创建的 · 1")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "打开歌单" })[0]!);
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 1, 20, "88");
    expect(screen.getAllByText("晴天").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /返回全部歌单/ }));
    expect(await screen.findByRole("heading", { name: "我的歌单" })).toBeInTheDocument();
  });

  it("选择目标歌单后沿用既有加入歌单路径，选择器不会读取额外 Provider 数据", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => Promise.resolve({
      kind, page: 1, hasMore: false, total: kind === "created" ? 2 : 0, warningCount: 0,
      items: kind === "created" ? [
        { id: "99123456", editableId: "88", title: "我喜欢", songCount: 11 },
        { id: "99123457", editableId: "89", title: "夜航目标", songCount: 4 },
      ] : [],
    }));

    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });

    await user.click(screen.getByRole("combobox", { name: "目标歌单：我喜欢" }));
    await user.click(screen.getByRole("option", { name: "夜航目标" }));
    await user.click(screen.getByRole("button", { name: "加入歌单" }));

    await waitFor(() => expect(addToPlaylistMock).toHaveBeenCalledWith("99123457", "89", [SONG.id]));
    expect(playlistSongsMock).toHaveBeenCalledTimes(1);
    expect(playlistsMock).toHaveBeenCalledTimes(2);
  });

  it("搜索后选择未浏览的歌曲可查看详情并批量追加，保留已有队列且不启动播放", async () => {
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, _page: number, pageSize: number) => Promise.resolve(
      pageSize === 50 ? { ...PAGE, generation, items: [SONG, SONG_TWO] }
        : { ...PAGE, generation, hasMore: true },
    ));
    enqueueManyMock.mockImplementation(async (tracks) => ({
      generation: 3, selectedIndex: 0,
      items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }, ...tracks],
    }));
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.type(await screen.findByRole("searchbox", { name: "歌单内搜索" }), "夜曲");
    await user.click(await screen.findByRole("button", { name: /^夜曲/ }));
    expect(screen.getByRole("heading", { name: "夜曲" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "选择 夜曲" }));
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText("已将 1 首歌曲加入播放队列")).toBeInTheDocument();
    expect(enqueueManyMock).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: SONG_TWO.id })]);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });

  it("从表格或歌曲信息的歌手名字进入 Artist Page，并返回原歌单详情", async () => {
    const user = userEvent.setup();
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });

    await user.click(screen.getByRole("button", { name: /^晴天/ }));
    expect(screen.queryByRole("heading", { name: "周杰伦 · ARTIST" })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole("table")).getByRole("button", { name: "查看歌手 周杰伦" }));
    expect(await screen.findByRole("heading", { name: "周杰伦 · ARTIST" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
    expect(screen.getAllByText("叶惠美").length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "查看歌手 周杰伦" }).at(-1)!);
    expect(await screen.findByRole("heading", { name: "周杰伦 · ARTIST" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
  });

  it("打开歌单后读取全部分页，替换本地队列并播放第一首", async () => {
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, page: number, pageSize: number) => {
      if (pageSize === 20) return Promise.resolve({ ...PAGE, generation });
      if (page === 1) {
        return Promise.resolve({
          generation,
          page: 1,
          hasMore: true,
          total: 2,
          warningCount: 0,
          items: [SONG],
        });
      }
      return Promise.resolve({
        generation,
        page: 2,
        hasMore: false,
        total: 2,
        warningCount: 0,
        items: [SONG_TWO],
      });
    });

    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });
    await user.click(screen.getByRole("button", { name: "播放全部" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 1, 50, "88");
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 2, 50, "88");
    expect(replaceMock).toHaveBeenCalledWith([
      { id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs },
      { id: SONG_TWO.id, title: SONG_TWO.title, artist: SONG_TWO.artist, album: SONG_TWO.album, durationMs: SONG_TWO.durationMs },
    ]);
    await waitFor(() => expect(playMock).toHaveBeenCalledWith(SONG.id, 2));
    expect(await screen.findByText("已载入 2 首并开始播放")).toBeInTheDocument();
  });

  it("账号恢复期间不读取喜欢，认证后以 20 首自动读取", async () => {
    const view = renderWorkspace("liked", { state: "signedOut" } as const, true);
    expect(screen.getByText("正在恢复账号")).toBeInTheDocument();
    expect(likedMock).not.toHaveBeenCalled();

    view.rerender(
      <LibraryWorkspace
        authRecovering={false}
        authSnapshot={AUTHENTICATED}
        initialSection="liked"
        onBack={() => undefined}
      />,
    );
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(likedMock).toHaveBeenCalledWith(1, 20, expect.any(Number));
  });

  it("创建歌单失败时仍显示收藏歌单并只重试创建分区", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => kind === "created"
      ? Promise.reject(new Error("created unavailable"))
      : Promise.resolve({
          kind, page: 1, hasMore: false, total: 1, warningCount: 0,
          items: [{ id: "772233", title: "夜航收藏", description: "", songCount: 9 }],
        }));

    renderWorkspace("playlists");
    expect(await screen.findByText("创建歌单暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("夜航收藏")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取创建歌单" }));
    await waitFor(() => {
      expect(playlistsMock.mock.calls.filter(([kind]) => kind === "created")).toHaveLength(2);
    });
    expect(playlistsMock.mock.calls.filter(([kind]) => kind === "favorite")).toHaveLength(1);
  });

  it("收藏歌单失败时仍显示创建歌单", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => kind === "favorite"
      ? Promise.reject(new Error("favorite unavailable"))
      : Promise.resolve({
          kind, page: 1, hasMore: false, total: 1, warningCount: 0,
          items: [{ id: "99123456", editableId: "88", title: "我喜欢", description: "", songCount: 11 }],
        }));

    renderWorkspace("playlists");
    expect(await screen.findByText("收藏歌单暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("我喜欢")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取收藏歌单" }));
    await waitFor(() => {
      expect(playlistsMock.mock.calls.filter(([kind]) => kind === "favorite")).toHaveLength(2);
    });
    expect(playlistsMock.mock.calls.filter(([kind]) => kind === "created")).toHaveLength(1);
  });

  it("喜欢读取失败后只重试喜欢歌曲", async () => {
    const user = userEvent.setup();
    likedMock.mockRejectedValue(new Error("liked unavailable"));
    renderWorkspace("liked");
    expect(await screen.findByText("喜欢的音乐暂时不可用")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取喜欢的音乐" }));
    await waitFor(() => expect(likedMock).toHaveBeenCalledTimes(2));
    expect(playlistsMock).not.toHaveBeenCalled();
  });

  describe("歌单页内来源切换", () => {
    const folder = (id: "netease" | "bilibili"): ProviderContainer => ({
      providerId: id, id: id === "netease" ? "netease:playlist:7" : "bilibili:favorite:7",
      kind: id === "netease" ? "playlist" : "favoriteFolder", ownership: "created",
      owner: { providerId: id, id: "42" }, title: `${id} 合成歌单`, description: "", itemCount: 2, allowedActions: [],
    });
    beforeEach(() => {
      localStorage.clear();
      vi.mocked(providers.nativeProviderStatus).mockImplementation(async id => ({
        providerId: id, state: "ready", account: { providerId: id, id: "42", displayName: "合成账号" },
        persistence: "saved", capabilities: constants.capabilities[id as "netease" | "bilibili"],
      } as ProviderSnapshot));
      vi.mocked(providers.nativeProviderLibraryContainers).mockReset().mockImplementation(async (id, kind) => ({
        page: 1, hasMore: false, total: kind === "created" ? 1 : 0, items: kind === "created" ? [folder(id)] : [],
      }));
    });
    function openPlaylists(auth: AuthSnapshot = AUTHENTICATED) {
      return render(<DesktopProviders><LibraryWorkspace authSnapshot={auth} authRecovering={false}
        initialSection="playlists" onBack={() => {}} /></DesktopProviders>);
    }
    function sources() { return within(screen.getByRole("navigation", { name: "歌单音乐来源" })); }

    it("QQ、网易和B站都在标题下保留同一组按钮，切换不触发播放", async () => {
      const user = userEvent.setup();
      openPlaylists();
      await screen.findByRole("heading", { name: "我喜欢" });
      expect(screen.getByRole("navigation", { name: "歌单音乐来源" }).closest(".catalog-pane")).toContainElement(screen.getByRole("heading", { name: "我的歌单" }));
      for (const [label, id] of [["网易云音乐", "netease"], ["Bilibili", "bilibili"]] as const) {
        await user.click(sources().getByRole("button", { name: label }));
        await screen.findByRole("heading", { name: folder(id).title });
        expect(sources().getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
        expect(providers.nativeProviderLibraryContainers).toHaveBeenCalledWith(id, "created", 1, 50);
        expect(screen.getAllByRole("navigation", { name: "歌单音乐来源" })).toHaveLength(1);
      }
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      await screen.findByRole("heading", { name: "我喜欢" });
      expect(sources().getByRole("button", { name: "QQ 音乐" })).toHaveAttribute("aria-pressed", "true");
      expect(enqueueMock).not.toHaveBeenCalled(); expect(playMock).not.toHaveBeenCalled();
    });

    it("网易未登录时仍可从页内切回QQ，未登录来源不读取歌单", async () => {
      const user = userEvent.setup();
      vi.mocked(providers.nativeProviderStatus).mockImplementation(async id => ({
        providerId: id, state: "disabled", capabilities: constants.capabilities[id as "netease" | "bilibili"],
      } as ProviderSnapshot));
      openPlaylists();
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      await screen.findByText(/登录此来源后访问曲库/);
      expect(screen.getByRole("navigation", { name: "歌单音乐来源" }).closest(".catalog-pane")).toBeInTheDocument();
      expect(providers.nativeProviderLibraryContainers).not.toHaveBeenCalled();
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      await screen.findByRole("heading", { name: "我的歌单" });
    });

    it("切回QQ后忽略迟到的网易歌单响应", async () => {
      const user = userEvent.setup();
      let resolve!: (value: ProviderPage<ProviderContainer>) => void;
      vi.mocked(providers.nativeProviderLibraryContainers).mockReturnValue(new Promise(done => { resolve = done; }));
      openPlaylists();
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      await waitFor(() => expect(providers.nativeProviderLibraryContainers).toHaveBeenCalled());
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      await act(async () => resolve({ page: 1, hasMore: false, total: 1, items: [folder("netease")] }));
      expect(screen.getByRole("heading", { name: "我的歌单" })).toBeInTheDocument();
      expect(screen.queryByText(folder("netease").title)).not.toBeInTheDocument();
    });
  });

  describe("多来源喜欢页", () => {
    const neteaseSong: ProviderTrack = {
      providerId: "netease", id: "netease:track:123", title: "网易喜欢歌曲", artist: "网易歌手",
      creatorKind: "artist", album: "网易专辑", durationMs: 123000, availability: "unknown",
    };
    beforeEach(() => {
      localStorage.clear();
      vi.mocked(providers.nativeProviderStatus).mockImplementation(async id => id === "netease" ? {
        providerId: id, state: "ready", account: { providerId: id, id: "42", displayName: "网易账号" },
        persistence: "saved", capabilities: constants.capabilities.netease,
      } as ProviderSnapshot : {
        providerId: id, state: "disabled", capabilities: constants.capabilities.bilibili,
      } as ProviderSnapshot);
      vi.mocked(providers.nativeProviderLibraryLikes).mockReset().mockResolvedValue({
        page: 1, hasMore: false, total: 1, items: [neteaseSong],
      });
    });
    function openLikes(auth: AuthSnapshot = { state: "signedOut" }, onAccount = vi.fn()) {
      return render(<DesktopProviders><LibraryWorkspace authSnapshot={auth} authRecovering={false}
        initialSection="liked" onBack={() => {}} onAccount={onAccount} /></DesktopProviders>);
    }
    function sources() { return within(screen.getByRole("navigation", { name: "喜欢的音乐来源" })); }

    it("仅登录网易时自动读取网易喜欢，不显示QQ数量；可显式切到未登录的QQ再切回", async () => {
      const user = userEvent.setup();
      openLikes();
      expect((await screen.findAllByText(neteaseSong.title)).length).toBeGreaterThan(0);
      expect(sources().getByRole("button", { name: "网易云音乐" })).toHaveAttribute("aria-pressed", "true");
      expect(providers.nativeProviderLibraryLikes).toHaveBeenCalledWith("netease", 1, 50);
      expect(likedMock).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "喜欢" }).querySelector("small")).toBeNull();
      expect(screen.queryByRole("navigation", { name: "此来源功能" })).not.toBeInTheDocument();
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      expect(await screen.findByText("请先登录后读取账号曲库")).toBeInTheDocument();
      expect(sources().getByRole("button", { name: "QQ 音乐" })).toHaveAttribute("aria-pressed", "true");
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      expect((await screen.findAllByText(neteaseSong.title)).length).toBeGreaterThan(0);
      expect(enqueueMock).not.toHaveBeenCalled(); expect(playMock).not.toHaveBeenCalled();
    });

    it("双登录时可从QQ切到网易，分页和只读刷新只读取网易", async () => {
      const user = userEvent.setup();
      vi.mocked(providers.nativeProviderLibraryLikes).mockImplementation(async (_id, page = 1) => ({
        page, hasMore: page === 1, total: 51, items: [{ ...neteaseSong, title: `网易喜欢第${page}页` }],
      }));
      openLikes(AUTHENTICATED);
      await screen.findAllByText(SONG.title);
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      await screen.findAllByText("网易喜欢第1页");
      const qqReads = likedMock.mock.calls.length;
      await user.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findAllByText("网易喜欢第2页");
      await user.click(screen.getByRole("button", { name: "只读刷新列表" }));
      await waitFor(() => expect(providers.nativeProviderLibraryLikes).toHaveBeenCalledTimes(3));
      expect(providers.nativeProviderLibraryLikes).toHaveBeenLastCalledWith("netease", 2, 50);
      expect(likedMock).toHaveBeenCalledTimes(qqReads);
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      await screen.findAllByText(SONG.title);
      expect(screen.queryByText("网易喜欢第2页")).not.toBeInTheDocument();
    });

    it("切回QQ后丢弃迟到的网易喜欢回复", async () => {
      const user = userEvent.setup();
      let resolve!: (value: ProviderPage<ProviderTrack>) => void;
      vi.mocked(providers.nativeProviderLibraryLikes).mockReturnValue(new Promise(done => { resolve = done; }));
      openLikes(AUTHENTICATED);
      await screen.findAllByText(SONG.title);
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      await waitFor(() => expect(providers.nativeProviderLibraryLikes).toHaveBeenCalled());
      await user.click(sources().getByRole("button", { name: "QQ 音乐" }));
      await act(async () => { resolve({ page: 1, hasMore: false, total: 1, items: [neteaseSong] }); });
      await screen.findAllByText(SONG.title);
      expect(screen.queryByText(neteaseSong.title)).not.toBeInTheDocument();
    });

    it("网易未登录仍保留切换按钮，账号入口指向网易", async () => {
      const user = userEvent.setup(); const account = vi.fn();
      vi.mocked(providers.nativeProviderStatus).mockImplementation(async id => ({
        providerId: id, state: "disabled", capabilities: constants.capabilities[id as "netease" | "bilibili"],
      } as ProviderSnapshot));
      openLikes({ state: "signedOut" }, account);
      await user.click(sources().getByRole("button", { name: "网易云音乐" }));
      expect(await screen.findByText(/登录此来源后访问曲库/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "打开此来源账号" }));
      expect(account).toHaveBeenCalledOnce();
      await waitFor(() => expect(localStorage.getItem("qqmusic_browse_source_v1")).toBe("netease"));
      expect(providers.nativeProviderLibraryLikes).not.toHaveBeenCalled(); expect(likedMock).not.toHaveBeenCalled();
    });

    it("网易读取失败可以手动重试，恢复后显示歌曲", async () => {
      const user = userEvent.setup();
      vi.mocked(providers.nativeProviderLibraryLikes).mockRejectedValueOnce(new Error("offline"));
      openLikes();
      await screen.findByText("读取失败；请手动刷新，应用没有重放写入");
      expect(providers.nativeProviderLibraryLikes).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "只读刷新列表" }));
      expect((await screen.findAllByText(neteaseSong.title)).length).toBeGreaterThan(0);
      expect(providers.nativeProviderLibraryLikes).toHaveBeenCalledTimes(2);
    });
  });
  it("播放超过队列上限的歌单时只载入前 1000 首", async () => {
    let queue = { generation: 2, selectedIndex: 0, items: [] as Array<{ id: string; title: string; artist: string; album: string; durationMs: number }> };
    replaceMock.mockImplementation(async items => queue = { ...queue, items });
    playMock.mockImplementation(async id => ({ queue, playback: { quality: "320k", expiresInSeconds: 300, player: {
      state: "playing", generation: 7, positionMs: 0, durationMs: queue.items.find(item => item.id === id)!.durationMs, volume: .72, muted: false,
      currentTrack: queue.items.find(item => item.id === id), failure: null,
    } } }));
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, page: number, pageSize: number) => {
      if (pageSize === 20) return Promise.resolve({ ...PAGE, generation });
      const all = Array.from({ length: 1001 }, (_, i) => ({ ...SONG, id: `song-${i}` }));
      return Promise.resolve({ ...PAGE, generation, page, hasMore: page * pageSize < all.length, items: all.slice((page - 1) * pageSize, page * pageSize) });
    });
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock.mock.calls[0]![0]).toHaveLength(1000);
    expect(await screen.findByText("歌单超过队列上限，已载入前 1000 首并开始播放")).toBeInTheDocument();
  });

  it("leaving the library cancels an unfinished play-all read", async () => {
    const user = userEvent.setup();
    let resolve!: (value: typeof PAGE) => void;
    playlistSongsMock.mockImplementation((_id: string, generation: number, _page: number, size: number) =>
      size === 20 ? Promise.resolve({ ...PAGE, generation }) : new Promise(r => { resolve = r; }));
    const view = renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    view.unmount();
    await act(async () => { resolve(PAGE); });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
