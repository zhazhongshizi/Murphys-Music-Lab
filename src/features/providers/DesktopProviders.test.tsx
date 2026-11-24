import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import * as api from "../../backend/providersAdapter";
import { invalidateProviderSession } from "../../backend/providerSessions";
import { installPlaybackTransport } from "../../backend/playbackTransport";
import type { NewProviderId, ProviderContainer, ProviderPage, ProviderSnapshot, ProviderTrack } from "../../contracts/providers";
import constants from "../../../contracts/protocol-v2.constants.json";
import { DesktopProviders, SourceNavigation, useDesktopProviders } from "./DesktopProviders";
import { DesktopAccountDialog } from "./ProviderAccount";
import { ProviderWorkspace, type RhineProviderSceneState } from "./ProviderWorkspace";
import { collectBilibiliFolderFirstParts, readAllProviderPages } from "./providerListHelpers";
import { SourceBadge } from "./SourceBadge";
import { playerActions, resetPlayerFixture } from "../player/playerStore";
import { nativeQueueEnqueueNext, nativeQueuePlay, nativeQueueReplace } from "../../backend/nativeQueueAdapter";

vi.mock("../../backend/providersAdapter", async original => ({
  ...await original<typeof import("../../backend/providersAdapter")>(),
  nativeProviderStatus: vi.fn(), nativeProviderLogin: vi.fn(), nativeProviderPoll: vi.fn(), nativeProviderCancel: vi.fn(), nativeProviderRestore: vi.fn(), nativeProviderLogout: vi.fn(), nativeProviderCheck: vi.fn(),
  nativeProviderSearchSongs: vi.fn(), nativeProviderSearchPlaylists: vi.fn(), nativeProviderSearchVideos: vi.fn(), nativeProviderLibraryContainers: vi.fn(), nativeProviderLibraryTracks: vi.fn(), nativeProviderLibraryVideos: vi.fn(), nativeProviderLibraryLikes: vi.fn(), nativeProviderContainer: vi.fn(), nativeProviderResolveVideo: vi.fn(), nativeProviderVideoParts: vi.fn(), nativeProviderEnqueueTracks: vi.fn(), nativeProviderEnqueueVideo: vi.fn(), nativeProviderWrite: vi.fn(),
}));
vi.mock("../player/playerStore", async original => {
  const mod = await original<typeof import("../player/playerStore")>();
  return {
    ...mod,
    playerActions: { ...mod.playerActions, hydrateNative: vi.fn(), refreshProviderLikes: vi.fn(), applyVerifiedProviderLike: vi.fn() },
  };
});
vi.mock("../../backend/nativeQueueAdapter", async original => ({ ...await original<typeof import("../../backend/nativeQueueAdapter")>(), nativeQueuePlay: vi.fn(), nativeQueueEnqueueNext: vi.fn(), nativeQueueReplace: vi.fn() }));

const ready = (id: NewProviderId, account = "42"): Extract<ProviderSnapshot, { state: "ready" }> => ({ providerId: id, state: "ready", account: { providerId: id, id: account, displayName: `Synthetic ${account}` }, persistence: "saved", capabilities: constants.capabilities[id] as ProviderSnapshot["capabilities"] });
const disabled = (id: NewProviderId): ProviderSnapshot => ({ providerId: id, state: "disabled", capabilities: constants.capabilities[id] as ProviderSnapshot["capabilities"] });
const song: ProviderTrack = { providerId: "netease", id: "netease:track:1", title: "网易歌曲", artist: "艺人", creatorKind: "artist", album: "专辑", durationMs: 10000, availability: "unknown" };
const part: ProviderTrack = { providerId: "bilibili", id: "bilibili:video:BV17x411w7KC:124", title: "视频 P2", artist: "测试 UP", creatorKind: "uploader", album: "视频", durationMs: 10000, availability: "unknown", video: { title: "视频", partTitle: "第二 P", partNumber: 2 } };
const video = { providerId: "bilibili" as const, bvid: "BV17x411w7KC", aid: "170001", title: "视频", uploader: "测试 UP", durationMs: 20000, availability: "unknown" as const };
const folder = (id: NewProviderId): ProviderContainer => ({ providerId: id, id: id === "netease" ? "netease:playlist:7" : "bilibili:favorite:7", kind: id === "netease" ? "playlist" : "favoriteFolder", owner: { providerId: id, id: "42" }, ownership: "created", title: "自建容器", description: "简介", itemCount: 2, allowedActions: id === "netease" ? ["playlist.addTracks", "playlist.removeTracks"] : ["favorite.addVideos", "favorite.removeVideos"] });
const page = <T,>(items: T[], hasMore = false, n = 1): ProviderPage<T> => ({ page: n, items, total: items.length, hasMore });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { resolve, reject, promise }; }
let statuses: Record<NewProviderId, ProviderSnapshot>;
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); installPlaybackTransport(null);
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  statuses = { netease: ready("netease"), bilibili: ready("bilibili") };
  vi.mocked(api.nativeProviderStatus).mockImplementation(async id => statuses[id as NewProviderId]);
  vi.mocked(api.nativeProviderLibraryContainers).mockImplementation(async id => page([folder(id)]));
  vi.mocked(api.nativeProviderContainer).mockImplementation(async id => folder(id));
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([song]));
  vi.mocked(api.nativeProviderLibraryLikes).mockResolvedValue(page([song]));
  vi.mocked(api.nativeProviderSearchSongs).mockResolvedValue(page([song]));
  vi.mocked(api.nativeProviderSearchPlaylists).mockResolvedValue(page([folder("netease")]));
  vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([video]));
  vi.mocked(api.nativeProviderSearchVideos).mockResolvedValue(page([video]));
  vi.mocked(api.nativeProviderResolveVideo).mockResolvedValue(video);
  vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([part]));
  vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [{ id: song.id, providerId: "netease", title: song.title, artist: song.artist, album: song.album, durationMs: song.durationMs }] });
  vi.mocked(nativeQueuePlay).mockResolvedValue(null);
  vi.mocked(nativeQueueReplace).mockImplementation(async items => ({ generation: 2, selectedIndex: 0, items }));
  vi.mocked(nativeQueueEnqueueNext).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [api.providerTrackToQueueTrack(song)] });
  vi.mocked(api.nativeProviderWrite).mockResolvedValue({ status: "applied", affectedCount: null });
  vi.mocked(api.nativeProviderCancel).mockResolvedValue();
});
afterEach(() => { cleanup(); resetPlayerFixture(); vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); installPlaybackTransport(null); });
function Harness({ variant, onScene }: { variant: "default" | "rhine"; onScene?: (scene: RhineProviderSceneState) => void }) {
  const [account, setAccount] = useState(false);
  const [section, setSection] = useState<"created" | "favorite" | "likes" | "search">("search");
  const { source, refresh } = useDesktopProviders();
  return <>{variant === "rhine" && <nav aria-label="档案分类"><button onClick={() => setSection("created")}>自建</button><button onClick={() => setSection("favorite")}>收藏</button><button onClick={() => setSection("likes")}>喜欢</button><button onClick={() => setSection("search")}>搜索</button></nav>}<SourceNavigation variant={variant} onAccount={() => setAccount(true)} /><button onClick={() => { if (source === "netease" || source === "bilibili") void refresh(source); }}>刷新测试会话</button><ProviderWorkspace variant={variant} initialSection={section} onArchive={() => setSection("created")} onAccount={() => setAccount(true)} onRhineSceneChange={onScene} />{account && <DesktopAccountDialog variant={variant} auth={{ state: "signedOut" }} onAuthChange={() => {}} onClose={() => setAccount(false)} />}</>;
}
async function open(variant: "default" | "rhine", id: NewProviderId = "netease", onScene?: (scene: RhineProviderSceneState) => void) {
  const view = render(<DesktopProviders><Harness variant={variant} onScene={onScene} /></DesktopProviders>);
  fireEvent.click(within(screen.getByRole("navigation", { name: "音乐来源" })).getByRole("button", { name: id === "netease" ? "网易云" : "Bilibili" }));
  await screen.findByRole("region", { name: `${id === "netease" ? "网易云" : "Bilibili"}曲库` });
  if (statuses[id].state === "ready") {
    if (variant === "rhine") {
      await screen.findByLabelText("搜索关键词");
      if (id === "bilibili") fireEvent.click(screen.getByText("通过 BV/AV 或链接打开分 P"));
    } else await screen.findByRole("heading", { name: `${id === "netease" ? "网易云" : "Bilibili"} · ${statuses[id].account.displayName}` });
  }
  return view;
}
describe.each(["default", "rhine"] as const)("%s full provider desktop", variant => {
  it("disabled sources use only local status and never start QR, restore or library requests", async () => {
    statuses.netease = disabled("netease"); await open(variant);
    expect(screen.getByText(/登录此来源后访问曲库/)).toBeInTheDocument();
    expect(api.nativeProviderLibraryContainers).not.toHaveBeenCalled(); expect(api.nativeProviderRestore).not.toHaveBeenCalled(); expect(api.nativeProviderLogin).not.toHaveBeenCalled(); expect(api.nativeProviderSearchSongs).not.toHaveBeenCalled();
  });
  it("new source search is explicit; navigating sources discards delayed results", async () => {
    const d = deferred<ProviderPage<ProviderTrack>>(); vi.mocked(api.nativeProviderSearchSongs).mockReturnValue(d.promise);
    await open(variant); expect(api.nativeProviderSearchSongs).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "固定关键词" } }); fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
    expect(api.nativeProviderSearchSongs).toHaveBeenCalledWith("netease", "固定关键词", 1, 50);
    fireEvent.click(within(screen.getByRole("navigation", { name: "音乐来源" })).getByRole("button", { name: "Bilibili" }));
    await act(async () => { d.resolve(page([song])); });
    expect(screen.queryByText("网易歌曲")).not.toBeInTheDocument(); expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it("fresh owner/allowedActions govern container removal; pending is verified read-only", async () => {
    vi.mocked(api.nativeProviderWrite).mockResolvedValueOnce({ status: "verificationPending", affectedCount: null }).mockResolvedValueOnce({ status: "applied", affectedCount: null });
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
    const check = await screen.findByRole("checkbox", { name: "网易歌曲" }); fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "从当前歌单移出选中" }));
    await screen.findByText(/结果待核对，可能部分完成/);
    expect(screen.getByRole("button", { name: "从当前歌单移出选中" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "只读核对结果" }));
    await waitFor(() => expect(api.nativeProviderWrite).toHaveBeenLastCalledWith({ providerId: "netease", accountId: "42", operation: { kind: "removeItems", containerId: "netease:playlist:7", trackIds: [song.id] } }, true));
    expect(api.nativeProviderWrite).toHaveBeenCalledTimes(2);
  });
  it("a collected container never enables content removal even when the source supports writes", async () => {
    vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), ownership: "collected", owner: { providerId: "netease", id: "99" }, allowedActions: ["playlist.subscribe", "playlist.unsubscribe"] });
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "自建" })); fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "网易歌曲" }));
    expect(screen.getByRole("button", { name: "从当前歌单移出选中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "收藏此歌单" })).toBeEnabled(); expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it("capabilities hide unsupported library kinds and disable unsupported mutations", async () => {
    const status = ready("netease"); statuses.netease = { ...status, capabilities: { ...status.capabilities, libraryKinds: [], writeActions: [], searchKinds: ["songs"] } };
    await open(variant);
    const workspace = within(screen.getByRole("region", { name: "网易云曲库" }));
    expect(workspace.queryByRole("button", { name: "喜欢的歌曲" })).not.toBeInTheDocument(); expect(workspace.queryByRole("button", { name: "自建" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "歌曲" } }); fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
    if (variant === "default") {
      await screen.findByRole("checkbox", { name: song.title });
      fireEvent.click(screen.getByRole("button", { name: "曲目检视栏" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "网易喜欢 / 歌单操作" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "喜欢此歌曲" })).toBeDisabled()); expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it("Bilibili reads real parts, selects a CID, and queues intact metadata", async () => {
    await open(variant, "bilibili");
    fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } }); fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: part.title }));
    expect(screen.getAllByText("Bilibili · P2").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Bilibili · P2 · 第二 P").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /选中加入队列/ }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([part])); expect(nativeQueuePlay).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "喜欢的歌曲" })).not.toBeInTheDocument();
  });
  async function searchVideo() {
    await open(variant, "bilibili");
    fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "视频" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
    if (variant === "default") {
      await screen.findByRole("button", { name: `播放 ${video.title}` });
      fireEvent.click(screen.getByRole("button", { name: "曲目检视栏" }));
    }
    return screen.findByRole("button", { name: "播放" });
  }
  it.each([true, false])("single-part video acts directly without a part picker (play=%s)", async play => {
    const single: ProviderTrack = { ...part, video: { ...part.video!, partNumber: 1 } };
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([single]));
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [single] });
    await searchVideo();
    fireEvent.click(screen.getByRole("button", { name: play ? "播放" : "加入队列" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([single]));
    if (play) await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(single.id, 1));
    else expect(nativeQueuePlay).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "全部分 P 加入队列" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
    expect(api.nativeProviderVideoParts).toHaveBeenCalledExactlyOnceWith(video.bvid, 1, 100);
  });
  it.each([false, true])("multiple or paginated parts open the picker without queueing (hasMore=%s)", async hasMore => {
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page(hasMore ? [part] : [part, { ...part, id: "bilibili:video:BV17x411w7KC:125" }], hasMore));
    const button = await searchVideo();
    fireEvent.click(button);
    await screen.findByRole("button", { name: "全部分 P 加入队列" });
    expect(api.nativeProviderVideoParts).toHaveBeenCalledExactlyOnceWith(video.bvid, 1, 100);
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
  });
  it("single-part favorite videos play directly from the folder", async () => {
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [part] });
    await open(variant, "bilibili");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
    if (variant === "default") {
      await screen.findByRole("checkbox", { name: video.title });
      fireEvent.click(screen.getByRole("button", { name: "曲目检视栏" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(part.id, 1));
    expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([part]);
    expect(screen.queryByRole("button", { name: "全部分 P 加入队列" })).not.toBeInTheDocument();
  });
  it("unavailable single-part videos do not play or queue", async () => {
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([{ ...part, availability: "deleted" }]));
    fireEvent.click(await searchVideo());
    await screen.findByText("此视频当前不可播放或入队");
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
  });
  it("video read failure stays in the list and does not queue", async () => {
    vi.mocked(api.nativeProviderVideoParts).mockRejectedValue(new Error("read failed"));
    fireEvent.click(await searchVideo());
    await screen.findByText("视频读取失败，请重试；未播放或入队");
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
  });
  it("leaving the video list discards a delayed single-part playback request", async () => {
    const d = deferred<ProviderPage<ProviderTrack>>();
    vi.mocked(api.nativeProviderVideoParts).mockReturnValue(d.promise);
    const button = await searchVideo();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.nativeProviderVideoParts).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    await act(async () => { d.resolve(page([part])); });
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
  });
  it("a later link input invalidates an earlier video resolution", async () => {
    const d = deferred<typeof video>(); vi.mocked(api.nativeProviderResolveVideo).mockReturnValueOnce(d.promise);
    await open(variant, "bilibili");
    fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } }); fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
    fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: "BV17x411w7KD" } });
    await act(async () => { d.resolve(video); });
    expect(api.nativeProviderVideoParts).not.toHaveBeenCalled(); expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
  });
  it("same-account re-login discards old read results and selection", async () => {
    const d = deferred<ProviderPage<ProviderTrack>>(); vi.mocked(api.nativeProviderSearchSongs).mockReturnValueOnce(d.promise);
    await open(variant); fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "歌曲" } }); fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
    act(() => invalidateProviderSession("netease"));
    fireEvent.click(screen.getByRole("button", { name: "刷新测试会话" }));
    await act(async () => { d.resolve(page([song])); });
    expect(screen.queryByText(song.title)).not.toBeInTheDocument(); expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it.each(["全部歌曲加入队列", "播放全部"])("handles a 895-track playlist with unavailable tracks and a cross-page duplicate: %s", async action => {
    const rows: ProviderTrack[] = Array.from({ length: 895 }, (_, i) => ({ ...song, id: `netease:track:${i + 1}` }));
    rows[0] = { ...rows[0]!, availability: "deleted" };
    rows[500] = rows[1]!;
    rows[894] = { ...rows[894]!, availability: "unavailable" };
    const expected = rows.filter((_, index) => ![0, 500, 894].includes(index));
    vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), itemCount: rows.length });
    vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1, size) => size === 100
      ? { ...page(rows.slice((n - 1) * size, n * size), n * size < rows.length, n), total: rows.length }
      : page([rows[0]!, rows[1]!], true));
    const player = {
      state: "playing" as const, generation: 3, currentTrack: api.providerTrackToQueueTrack(expected[0]!),
      positionMs: 0, durationMs: song.durationMs, volume: 0.5, muted: false, failure: null,
    };
    const queue = { generation: 2, selectedIndex: 0, items: expected.map(api.providerTrackToQueueTrack) };
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(queue);
    vi.mocked(nativeQueuePlay).mockResolvedValue({
      requestedQuality: "320k", queue,
      playback: { player, quality: "320k", expiresInSeconds: 60 },
    });
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "自建" })); fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
    const button = await screen.findByRole("button", { name: action });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText(/892 首.*跳过 2 首不可用歌曲；去除 1 首重复歌曲/);
    const reads = vi.mocked(api.nativeProviderLibraryTracks).mock.calls.filter(([, , , size]) => size === 100);
    expect(reads.map(([, , n]) => n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (action === "播放全部") {
      expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith(queue.items);
      expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(expected[0]!.id, 2);
      expect(playerActions.hydrateNative).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }), player, "320k", undefined);
      expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    } else {
      expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith(expected);
      expect(nativeQueueReplace).not.toHaveBeenCalled();
      expect(nativeQueuePlay).not.toHaveBeenCalled();
    }
  });
  it("QR returned after closing is cancelled and never polled", async () => {
    statuses.netease = disabled("netease"); const d = deferred<import("../../contracts/providers").ProviderQrImage>(); vi.mocked(api.nativeProviderLogin).mockReturnValueOnce(d.promise);
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "打开此来源账号" }));
    await waitFor(() => expect(api.nativeProviderLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "恢复已保存登录" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "平台账号" })).queryByRole("button", { name: "刷新账号状态" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭登录窗口" }));
    await act(async () => { d.resolve({ sessionId: "synthetic-qr", mimeType: "image/png", imageBase64: "iVBORw0KGgo=", expiresAtMs: Date.now() + 180000, pollAfterMs: 2000 }); });
    expect(api.nativeProviderCancel).toHaveBeenCalledWith("netease", "synthetic-qr"); expect(api.nativeProviderPoll).not.toHaveBeenCalled();
  });
  it("QR polling confirms the account, stops after authentication and exposes session-only persistence", async () => {
    statuses.netease = disabled("netease"); await open(variant);
    vi.mocked(api.nativeProviderLogin).mockResolvedValue({ sessionId: "synthetic-qr", mimeType: "image/png", imageBase64: "iVBORw0KGgo=", expiresAtMs: Date.now() + 180000, pollAfterMs: 2000 });
    vi.mocked(api.nativeProviderPoll).mockImplementationOnce(async () => {
      statuses.netease = { ...ready("netease"), persistence: "sessionOnly" };
      return { sessionId: "synthetic-qr", state: "authenticated", account: { providerId: "netease", id: "42", displayName: "Synthetic" }, persistence: "sessionOnly" };
    });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开此来源账号" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByAltText("网易云登录二维码")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByAltText("网易云登录二维码")).not.toBeInTheDocument();
    expect(screen.getByText(/登录成功，本次已登录，未能保存/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.nativeProviderPoll).toHaveBeenCalledTimes(1);
    expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it("switching account tabs cancels a late QR and automatically starts the selected platform once", async () => {
    statuses.netease = disabled("netease"); statuses.bilibili = disabled("bilibili");
    const old = deferred<import("../../contracts/providers").ProviderQrImage>();
    const image = (sessionId: string) => ({ sessionId, mimeType: "image/png" as const, imageBase64: "iVBORw0KGgo=", expiresAtMs: Date.now()+180000, pollAfterMs: 60000 });
    vi.mocked(api.nativeProviderLogin).mockImplementation(id => id === "netease" ? old.promise : Promise.resolve(image("bili-new")));
    await open(variant); fireEvent.click(screen.getByRole("button", {name:"打开此来源账号"}));
    await waitFor(() => expect(api.nativeProviderLogin).toHaveBeenCalledExactlyOnceWith("netease"));
    fireEvent.click(within(screen.getByRole("navigation", {name:"平台账号"})).getByRole("button", {name:"Bilibili"}));
    await screen.findByAltText("Bilibili登录二维码");
    await act(async () => old.resolve(image("netease-old")));
    expect(api.nativeProviderCancel).toHaveBeenCalledWith("netease","netease-old");
    expect(api.nativeProviderLogin).toHaveBeenCalledTimes(2);
    expect(screen.queryByAltText("网易云登录二维码")).not.toBeInTheDocument();
    expect(api.nativeProviderPoll).not.toHaveBeenCalled();
  });
  it("logout removes only that platform and leaves the other ready account usable", async () => {
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "网易云账号 · 已登录" }));
    vi.mocked(api.nativeProviderLogout).mockImplementation(async (id = "netease") => { statuses[id] = disabled(id); invalidateProviderSession(id); });
    fireEvent.click(await screen.findByRole("button", { name: "退出此平台" }));
    await screen.findByText(/已退出此平台，其他来源保持不变/);
    fireEvent.click(within(screen.getByRole("navigation", { name: "平台账号" })).getByRole("button", { name: "Bilibili" }));
    expect(screen.getByRole("button", { name: "退出此平台" })).toBeEnabled();
    expect(api.nativeProviderLogout).toHaveBeenCalledExactlyOnceWith("netease");
  });
  it("reuses existing Normal catalog/inspector and Rhine shelf/document/search surfaces", async () => {
    const scenes: RhineProviderSceneState[] = [];
    const view = await open(variant, "netease", s => scenes.push(s));
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    await screen.findByRole("button", { name: "打开歌单" });
    if (variant === "default") {
      expect(view.container.querySelector(".catalog-pane")).not.toBeNull();
      expect(view.container.querySelector(".catalog-inspector")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "曲目检视栏" }));
      expect(view.container.querySelector(".catalog-inspector")).not.toBeNull();
      expect(view.container.querySelector(".playlist-grid .playlist-card")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "打开歌单" }));
      await screen.findByRole("checkbox", { name: "网易歌曲" });
      expect(view.container.querySelector("table.catalog-table")).not.toBeNull();
    } else {
      expect(view.container.querySelector(".rhine-provider-bar")).toBeNull();
      expect(view.container.querySelector(".rhine-selection")).not.toBeNull();
      expect(view.container.querySelector(".rhine-catalog .rhine-card-list")).not.toBeNull();
      await waitFor(() =>
        expect(scenes.at(-1)).toMatchObject({ titles: ["自建容器"], selected: 0, detail: false, searchMode: false }),
      );
      fireEvent.click(screen.getByRole("button", { name: "打开歌单" }));
      await screen.findByRole("checkbox", { name: "网易歌曲" });
      expect(view.container.querySelector(".rhine-document.rhine-playlist-document")).not.toBeNull();
      expect(view.container.querySelector("ol.rhine-songs")).not.toBeNull();
      await waitFor(() =>
        expect(scenes.at(-1)).toMatchObject({ detail: true, searchMode: false }),
      );
    }
  });
  it("enqueues next for Netease playlist tracks without triggering immediate playback", async () => {
    await open(variant, "netease");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
    const button = await screen.findByRole("button", { name: `下一首播放 ${song.title}` });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(nativeQueueEnqueueNext).toHaveBeenCalledWith(api.providerTrackToQueueTrack(song)));
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    await screen.findByText(`下一首播放：${song.title}`);
  });
  it("enqueues next for Bilibili favorite single-part video directly without triggering playback", async () => {
    await open(variant, "bilibili");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
    const button = await screen.findByRole("button", { name: `下一首播放 ${video.title}` });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(nativeQueueEnqueueNext).toHaveBeenCalledWith(api.providerTrackToQueueTrack(part)));
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    await screen.findByText(`下一首播放：${part.title}`);
  });
  it("prompts on multi-part Bilibili favorite video and enqueues chosen part as next", async () => {
    const secondPart = { ...part, id: "bilibili:video:BV17x411w7KC:125", title: "视频 P3" };
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([part, secondPart]));
    await open(variant, "bilibili");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
    const videoNextBtn = await screen.findByRole("button", { name: `下一首播放 ${video.title}` });
    fireEvent.click(videoNextBtn);
    await screen.findByText("此视频有多个分 P，请选择要下一首播放的内容");
    expect(nativeQueueEnqueueNext).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    const partNextBtn = await screen.findByRole("button", { name: `下一首播放 ${part.title}` });
    fireEvent.click(partNextBtn);
    await waitFor(() => expect(nativeQueueEnqueueNext).toHaveBeenCalledWith(api.providerTrackToQueueTrack(part)));
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    await screen.findByText(`下一首播放：${part.title}`);
  });
  it("enqueues next for Bilibili direct video parts without triggering immediate playback", async () => {
    await open(variant, "bilibili");
    fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } });
    fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
    const button = await screen.findByRole("button", { name: `下一首播放 ${part.title}` });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(nativeQueueEnqueueNext).toHaveBeenCalledWith(api.providerTrackToQueueTrack(part)));
    expect(nativeQueuePlay).not.toHaveBeenCalled();
    await screen.findByText(`下一首播放：${part.title}`);
  });
});
it("Rhine shares QQ search layout, keeps histories per source and returns to the shelf", async () => {
  const view = await open("rhine");
  expect(view.container.querySelector(".rhine-search-heading")).not.toBeNull();
  expect(view.container.querySelector(".rhine-search-body .rhine-search-history")).not.toBeNull();
  expect(within(screen.getByLabelText("搜索类型")).queryByRole("button", { name: "歌手" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "网易关键词" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
  await screen.findByText("网易歌曲");
  fireEvent.click(within(screen.getByLabelText("搜索类型")).getByRole("button", { name: "歌单" }));
  await waitFor(() => expect(api.nativeProviderSearchPlaylists).toHaveBeenCalledWith("netease", "网易关键词", 1, 50));
  expect(localStorage.getItem("qqmusic_search_history_v1")).toBeNull();
  fireEvent.click(within(screen.getByLabelText("音乐来源")).getByRole("button", { name: "Bilibili" }));
  await screen.findByLabelText("搜索关键词");
  expect(screen.queryByText("网易关键词", { selector: ".search-history button" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "视频关键词" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
  await waitFor(() => expect(api.nativeProviderSearchVideos).toHaveBeenCalledWith("视频关键词", 1, 50));
  fireEvent.click(screen.getByRole("button", { name: "清空搜索历史" }));
  expect(localStorage.getItem("qqmusic_bilibili_search_history_v1")).toBe("[]");
  expect(localStorage.getItem("qqmusic_netease_search_history_v1")).toContain("网易关键词");
  fireEvent.click(screen.getByRole("button", { name: "返回档案" }));
  await screen.findByRole("button", { name: "打开收藏夹" });
  expect(view.container.querySelector(".rhine-search")).toBeNull();
});
it("Remote does not expose desktop source navigation or query desktop accounts", async () => {
  installPlaybackTransport(vi.fn()); render(<DesktopProviders><SourceNavigation /></DesktopProviders>);
  expect(screen.queryByRole("navigation", { name: "音乐来源" })).not.toBeInTheDocument(); expect(api.nativeProviderStatus).not.toHaveBeenCalled();
});
it("Rhine returns from a favorite video to its folder without duplicating the back row", async () => {
  vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([part, { ...part, id: "bilibili:video:BV17x411w7KC:125" }]));
  await open("rhine", "bilibili");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
  fireEvent.click(await screen.findByRole("button", { name: "播放" }));
  await screen.findByRole("button", { name: "全部分 P 加入队列" });
  expect(screen.queryByRole("button", { name: "返回视频列表" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "自建容器" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回收藏夹" }));
  await screen.findByRole("button", { name: "返回收藏夹列表" });
  expect(screen.getByRole("heading", { name: "自建容器" })).toBeInTheDocument();
});
it("a concurrent session observation gets one bounded local snapshot reread and no platform startup", async () => {
  let neteaseReads = 0;
  vi.mocked(api.nativeProviderStatus).mockImplementation(async id => {
    if (id === "netease" && neteaseReads++ === 0) throw new api.ProviderAdapterError("QMG-PROVIDER-001", "cancelled");
    return statuses[id as NewProviderId];
  });
  await open("default");
  expect(neteaseReads).toBe(2); expect(api.nativeProviderLogin).not.toHaveBeenCalled(); expect(api.nativeProviderRestore).not.toHaveBeenCalled();
});
it("source labels preserve four platform identities and video part labels", () => {
  render(<><SourceBadge track={song} /><SourceBadge track={part} /><SourceBadge track={{ id: "qqSong" }} /><SourceBadge track={{ id: `local_${"a".repeat(64)}_mp3` }} /></>);
  expect(screen.getByText("网易云")).toBeInTheDocument(); expect(screen.getByText(/Bilibili.*P2/)).toBeInTheDocument(); expect(screen.getByText("QQ 音乐")).toBeInTheDocument(); expect(screen.getByText("本地音乐")).toBeInTheDocument();
});

async function openRhinePlaylist(id: NewProviderId) {
  await open("rhine", id);
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: id === "bilibili" ? "打开收藏夹" : "打开歌单" }));
  return screen.findByRole("region", { name: "歌单详情" });
}
it("Rhine Netease uses the QQ detail layout and searches every page before selecting results", async () => {
  const second = { ...song, id: "netease:track:2", title: "第二首", artist: "目标歌手" };
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, n=1, size) =>
    size === 50 ? { ...page([n === 1 ? song : second], n === 1, n), total: 2 } : page([song]));
  const detail = await openRhinePlaylist("netease");
  expect(detail).toHaveClass("rhine-document", "rhine-playlist-document");
  expect(detail.querySelector(".provider-rhine-results")).toBeNull();
  const input = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
  fireEvent.change(input, { target: { value: "目标歌手" } }); fireEvent.submit(input.closest("form")!);
  await within(detail).findByText("第二首");
  expect(within(detail).queryByText("网易歌曲")).not.toBeInTheDocument();
  expect(api.nativeProviderLibraryTracks).toHaveBeenCalledWith("netease", "netease:playlist:7", 2, 50);
  expect(within(detail).getByText("第二首").closest("li")).toHaveAttribute("value", "2");
  fireEvent.click(within(detail).getByRole("checkbox", { name: "全选搜索结果" }));
  expect(within(detail).getByText("已选 1 首")).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole("button", { name: "清空选择" }));
  expect(within(detail).getByText("已选 0 首")).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole("button", { name: "清除" }));
  await within(detail).findByText("网易歌曲");
  expect(api.nativeProviderSearchSongs).not.toHaveBeenCalled();
});
it("Rhine favorite search finds videos by UP on later pages without a global search", async () => {
  const second = { ...video, bvid: "BV17x411w7KD", title: "后页视频", uploader: "目标 UP" };
  vi.mocked(api.nativeProviderLibraryVideos).mockImplementation(async (_container, n=1) => ({ ...page([n === 1 ? video : second], n === 1, n), total: 2 }));
  const detail = await openRhinePlaylist("bilibili");
  const input = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
  fireEvent.change(input, { target: { value: "目标 UP" } }); fireEvent.submit(input.closest("form")!);
  await within(detail).findByText("后页视频");
  expect(within(detail).queryByRole("button", { name: "从当前收藏夹移出选中" })).not.toBeInTheDocument();
  expect(api.nativeProviderSearchVideos).not.toHaveBeenCalled();
  fireEvent.click(within(detail).getByRole("button", { name: "播放" }));
  await waitFor(() => expect(api.nativeProviderVideoParts).toHaveBeenCalledWith(second.bvid, 1, 100));
  expect(detail.querySelector(".rhine-song-actions button")?.textContent).toBe("");
});
it("Rhine full-playlist search failure exposes retry without actionable partial results", async () => {
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, n=1, size) => {
    if (size !== 50) return page([song]);
    if (n === 1) return page([song], true);
    throw new Error("page failed");
  });
  const detail = await openRhinePlaylist("netease");
  const input = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
  fireEvent.change(input, { target: { value: "网易" } }); fireEvent.submit(input.closest("form")!);
  await within(detail).findByRole("alert");
  expect(within(detail).queryByRole("button", { name: "播放" })).not.toBeInTheDocument();
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([song]));
  fireEvent.click(within(detail).getByRole("button", { name: "重试" }));
  await within(detail).findByText("网易歌曲");
  expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
});
it("play-all preserves the existing queue if a later playlist page is incomplete", async () => {
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, n = 1, size) => {
    if (size !== 100) return page([song]);
    const items = n === 1 ? Array.from({ length: 100 }, (_, index) => ({ ...song, id: `netease:track:${index + 1}` })) : [];
    return { ...page(items, n === 1, n), total: 101 };
  });
  const detail = await openRhinePlaylist("netease");
  const button = await within(detail).findByRole("button", { name: "播放全部" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await within(detail).findByText(/整单读取未完成，队列未改变/);
  expect(nativeQueueReplace).not.toHaveBeenCalled();
  expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
  expect(nativeQueuePlay).not.toHaveBeenCalled();
});

it.each(["read", "replace", "hydrate"] as const)("leaving a playlist cancels play-all after %s and releases its busy state", async phase => {
  const detail = await openRhinePlaylist("netease");
  const button = await within(detail).findByRole("button", { name: "播放全部" });
  await waitFor(() => expect(button).toBeEnabled());
  const gate = deferred<void>();
  const queue = { generation: 1, selectedIndex: 0, items: [api.providerTrackToQueueTrack(song)] };
  if (phase === "read") vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, _page, size) => {
    if (size === 100) await gate.promise;
    return page([song]);
  });
  if (phase === "replace") vi.mocked(nativeQueueReplace).mockImplementation(async () => { await gate.promise; return queue; });
  if (phase === "hydrate") vi.mocked(playerActions.hydrateNative).mockImplementation(async () => { await gate.promise; });
  fireEvent.click(button);
  await waitFor(() => {
    if (phase === "read") expect(api.nativeProviderLibraryTracks).toHaveBeenCalledWith("netease", "netease:playlist:7", 1, 100);
    else if (phase === "replace") expect(nativeQueueReplace).toHaveBeenCalledTimes(1);
    else expect(playerActions.hydrateNative).toHaveBeenCalledTimes(1);
  });
  fireEvent.click(within(detail).getByRole("button", { name: "返回歌单列表" }));
  await screen.findByRole("button", { name: "打开歌单" });
  await act(async () => { gate.resolve(); });
  expect(nativeQueuePlay).not.toHaveBeenCalled();
  if (phase === "read") expect(nativeQueueReplace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开歌单" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "播放全部" })).toBeEnabled());
});

it("Rhine playlist refresh invalidates searched content and clears selection", async () => {
  const detail = await openRhinePlaylist("netease");
  const input = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
  fireEvent.change(input, { target: { value: "网易" } }); fireEvent.submit(input.closest("form")!);
  await within(detail).findByText("网易歌曲");
  fireEvent.click(within(detail).getByRole("checkbox", { name: "网易歌曲" }));
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([{ ...song, id: "netease:track:3", title: "网易刷新歌曲" }]));
  fireEvent.click(within(detail).getByRole("button", { name: "刷新歌单" }));
  await within(detail).findByText("网易刷新歌曲");
  expect(within(detail).queryByText("网易歌曲")).not.toBeInTheDocument();
  expect(within(detail).getByText("已选 0 首")).toBeInTheDocument();
});
it("leaving a Rhine playlist discards a delayed complete-search response", async () => {
  const d = deferred<ProviderPage<ProviderTrack>>();
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, _n, size) => size === 50 ? d.promise : page([song]));
  const detail = await openRhinePlaylist("netease");
  const input = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
  fireEvent.change(input, { target: { value: "网易" } }); fireEvent.submit(input.closest("form")!);
  fireEvent.click(within(screen.getByRole("navigation", { name: "音乐来源" })).getByRole("button", { name: "Bilibili" }));
  await act(async () => { d.resolve(page([song])); });
  expect(screen.queryByText("网易歌曲")).not.toBeInTheDocument();
  expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
  expect(api.nativeProviderWrite).not.toHaveBeenCalled();
});

it("F01/U03/U08: Default playlist searches page 2, hides non-matching tracks on zero match, and retries on read error", async () => {
  const second = { ...song, id: "netease:track:20", title: "第二页目标曲", artist: "目标作者" };
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1) =>
    n === 1 ? { ...page([song], true, 1), total: 51 } : { ...page([second], false, 2), total: 51 },
  );
  const view = await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  await screen.findByRole("checkbox", { name: "网易歌曲" });

  const searchInput = screen.getByPlaceholderText("在此歌单中搜索歌曲、歌手或专辑");
  fireEvent.change(searchInput, { target: { value: "目标作者" } });
  await screen.findByRole("checkbox", { name: "第二页目标曲" });
  expect(within(view.container.querySelector("table")!).queryByText("网易歌曲")).not.toBeInTheDocument();

  fireEvent.change(searchInput, { target: { value: "不存在的曲目" } });
  await screen.findByText("没有匹配“不存在的曲目”的条目");
  expect(view.container.querySelector("table")).not.toBeInTheDocument();

  fireEvent.change(searchInput, { target: { value: "" } });
  await screen.findByRole("checkbox", { name: "网易歌曲" });

  vi.mocked(api.nativeProviderLibraryTracks).mockRejectedValueOnce(new Error("boom"));
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText(/读取失败；未执行自动重放/);
  expect(view.container.querySelector("table")).not.toBeInTheDocument();
});

it("F02: Bilibili video play-all replaces queue and starts playback while enqueue-all appends silently", async () => {
  const parts2: ProviderTrack[] = [
    { ...part, id: "bilibili:video:BV17x411w7KC:124", title: "P1", video: { title: video.title, partTitle: "第一 P", partNumber: 1 } },
    { ...part, id: "bilibili:video:BV17x411w7KC:125", title: "P2", video: { title: video.title, partTitle: "第二 P", partNumber: 2 } },
  ];
  vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page(parts2));
  const queue = { generation: 2, selectedIndex: 0, items: parts2.map(api.providerTrackToQueueTrack) };
  vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(queue);
  vi.mocked(nativeQueuePlay).mockResolvedValue({
    requestedQuality: "320k",
    queue,
    playback: {
      player: { state: "playing", generation: 1, currentTrack: queue.items[0]!, positionMs: 0, durationMs: 10_000, volume: 0.5, muted: false, failure: null },
      quality: "aac",
      bitrate: 192000,
      expiresInSeconds: 0,
    },
  });

  await open("default", "bilibili");
  fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } });
  fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
  await screen.findByText("P2");
  const playAllBtn = await screen.findByRole("button", { name: "播放全部分 P" });
  fireEvent.click(playAllBtn);
  await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledWith(queue.items));
  await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(parts2[0]!.id, 2));
});

it.each(["default", "rhine"] as const)("F05: %s Netease likes supports full play-all, enqueue-all, and batch checkbox selection", async variant => {
  const second = { ...song, id: "netease:track:2", title: "喜欢第二首" };
  vi.mocked(api.nativeProviderLibraryLikes).mockResolvedValue(page([song, second]));
  const queue = { generation: 4, selectedIndex: 0, items: [song, second].map(api.providerTrackToQueueTrack) };
  vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(queue);

  await open(variant, "netease");
  fireEvent.click(screen.getByRole("button", { name: variant === "rhine" ? "喜欢" : "喜欢的歌曲" }));
  await screen.findByText("喜欢第二首");

  fireEvent.click(screen.getByRole("button", { name: "全部歌曲加入队列" }));
  await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([song, second]));
  expect(nativeQueuePlay).not.toHaveBeenCalled();

  const check2 = screen.getByRole("checkbox", { name: "喜欢第二首" });
  fireEvent.click(check2);
  expect(screen.getByText(/已选 1 项/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
  expect(screen.getByText(/已选 0 项/)).toBeInTheDocument();
});

it("F07: reverse & cross-page selection preserves list order rather than click order", async () => {
  const page1Songs = Array.from({ length: 50 }, (_, idx) => ({ ...song, id: `netease:track:${idx + 1}`, title: `曲目 ${idx + 1}` }));
  const page2Songs = [{ ...song, id: "netease:track:51", title: "曲目 51" }];
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1) =>
    n === 1 ? { ...page(page1Songs, true, 1), total: 51 } : { ...page(page2Songs, false, 2), total: 51 },
  );
  await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  await screen.findByRole("checkbox", { name: "曲目 1" });

  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("checkbox", { name: "曲目 51" });
  fireEvent.click(screen.getByRole("checkbox", { name: "曲目 51" }));

  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByRole("checkbox", { name: "曲目 1" });
  fireEvent.click(screen.getByRole("checkbox", { name: "曲目 1" }));

  fireEvent.click(screen.getByRole("button", { name: /选中加入队列/ }));
  await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledWith([page1Songs[0]!, page2Songs[0]!]));
}, 15_000);

it("F08/U09/U11: blocks unavailable tracks/videos, never displays 在线 as audio quality, and numbers 101st part accurately", async () => {
  const deadTrack: ProviderTrack = { ...song, id: "netease:track:99", title: "已下架曲目", availability: "deleted" };
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([song, deadTrack]));
  await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  await screen.findByText("已下架曲目");

  expect(screen.getByRole("checkbox", { name: "已下架曲目" })).toBeDisabled();
  expect(screen.getByText("已失效或删除")).toBeInTheDocument();
  expect(screen.queryByText("在线")).not.toBeInTheDocument();

  const part101: ProviderTrack = { ...part, id: "bilibili:video:BV17x411w7KC:223", title: "第一百零一 P", video: { title: video.title, partTitle: "P101", partNumber: 101 } };
  vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (_bvid, p = 1) =>
    p === 1 ? { ...page(Array.from({ length: 100 }, (_, i) => ({ ...part, id: `bilibili:video:BV17x411w7KC:${i + 1}`, title: `P${i + 1}` })), true, 1), total: 101 } : { ...page([part101], false, 2), total: 101 },
  );
  fireEvent.click(within(screen.getByRole("navigation", { name: "音乐来源" })).getByRole("button", { name: "Bilibili" }));
  await screen.findByLabelText("BV/AV 或视频链接");
  fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } });
  fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
  await screen.findByRole("checkbox", { name: "P100" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("checkbox", { name: "第一百零一 P" });
  expect(screen.getByText("101")).toBeInTheDocument();

  vi.mocked(api.nativeProviderSearchVideos).mockResolvedValue(page([{ ...video, bvid: "BV1dead", title: "失效视频", availability: "unavailable" }]));
  fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "失效" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
  await screen.findAllByText("失效视频");
  const toggleBtn = screen.getByRole("button", { name: "曲目检视栏" });
  if (toggleBtn.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggleBtn);
  }
  expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "加入队列" })).toBeDisabled();
}, 15_000);

it("U02/U06/U07: separates inspected row from playerStore playing highlight, keeps indeterminate checkbox, and records Default search history", async () => {
  const second = { ...song, id: "netease:track:2", title: "正在播放曲目" };
  vi.mocked(api.nativeProviderSearchSongs).mockResolvedValue(page([song, second]));
  const view = await open("default", "netease");

  fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "默认历史词" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
  await screen.findByText("正在播放曲目");
  expect(localStorage.getItem("qqmusic_netease_search_history_v1")).toContain("默认历史词");

  const selectAll = screen.getByRole("checkbox", { name: "全选本页" }) as HTMLInputElement;
  fireEvent.click(screen.getByRole("checkbox", { name: song.title }));
  expect(selectAll.indeterminate).toBe(true);

  act(() => {
    playerActions.applyAuthoritativeSession({
      mode: "sequence",
      requestedQuality: "320k",
      actualQuality: "320k",
      lyricOffsetMs: 0,
      queue: { generation: 1, selectedIndex: 1, items: [song, second].map(api.providerTrackToQueueTrack) },
      player: {
        state: "playing",
        generation: 1,
        currentTrack: api.providerTrackToQueueTrack(second),
        positionMs: 1000,
        durationMs: 10000,
        volume: 0.5,
        muted: false,
        failure: null,
      },
    });
  });

  const table = within(view.container.querySelector("table")!);
  const inspectedRow = table.getByText("网易歌曲").closest("tr")!;
  const playingRow = table.getByText("正在播放曲目").closest("tr")!;
  expect(playingRow).toHaveAttribute("data-playing", "true");
  expect(inspectedRow).not.toHaveAttribute("data-playing");
  fireEvent.click(screen.getByRole("checkbox", { name: song.title }));
  fireEvent.click(inspectedRow);
  expect(inspectedRow).toHaveAttribute("data-selected", "true");
  expect(inspectedRow).toHaveClass("provider-row--inspected");
  expect(playingRow).toHaveAttribute("data-playing", "true");
  expect(view.container.querySelectorAll('tr[data-playing="true"]')).toHaveLength(1);
});

it.each(["default", "rhine"] as const)(
  "F02 (%s): Bilibili favorite folder play-all and enqueue-all collect each playable video's first P and preserve queue on failure",
  async variant => {
    const v1 = { ...video, bvid: "BV17x411w7KA", title: "视频一" };
    const v2 = { ...video, bvid: "BV17x411w7KB", title: "已失效视频", availability: "deleted" as const };
    const v3 = { ...video, bvid: "BV17x411w7KD", title: "视频三" };
    const v1p1: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KA:101",
      title: "视频一 P1",
      video: { title: v1.title, partTitle: "P1", partNumber: 1 },
    };
    const v1p2: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KA:102",
      title: "视频一 P2",
      video: { title: v1.title, partTitle: "P2", partNumber: 2 },
    };
    const v3p1: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KD:301",
      title: "视频三 P1",
      video: { title: v3.title, partTitle: "P1", partNumber: 1 },
    };
    const v3p2: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KD:302",
      title: "视频三 P2",
      video: { title: v3.title, partTitle: "P2", partNumber: 2 },
    };
    const expected = [v1p1, v3p1];
    const queue = { generation: 2, selectedIndex: 0, items: expected.map(api.providerTrackToQueueTrack) };

    vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([v1, v2, v3]));
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async bvid => {
      if (bvid === v1.bvid) return page([v1p1, v1p2]);
      if (bvid === v3.bvid) return page([v3p1, v3p2]);
      throw new Error(`unexpected bvid: ${bvid}`);
    });
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(queue);
    vi.mocked(nativeQueuePlay).mockResolvedValue({
      requestedQuality: "320k",
      queue,
      playback: {
        player: {
          state: "playing",
          generation: 2,
          currentTrack: queue.items[0]!,
          positionMs: 0,
          durationMs: 10_000,
          volume: 0.5,
          muted: false,
          failure: null,
        },
        quality: "aac",
        bitrate: 192000,
        expiresInSeconds: 0,
      },
    });

    await open(variant, "bilibili");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
    await screen.findAllByText("视频一");

    const playAllBtn = await screen.findByRole("button", { name: "播放全部" });
    await waitFor(() => expect(playAllBtn).toBeEnabled());
    fireEvent.click(playAllBtn);

    await screen.findByText(/已载入 2 首；跳过 1 首不可用歌曲/);
    expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith(queue.items);
    expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(v1p1.id, 2);
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(api.nativeProviderVideoParts).not.toHaveBeenCalledWith(v2.bvid, expect.anything(), expect.anything());

    vi.mocked(nativeQueueReplace).mockClear();
    vi.mocked(nativeQueuePlay).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "全部加入队列" }));
    await screen.findByText(/2 首加入队列；跳过 1 首不可用歌曲/);
    expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith(expected);
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();

    vi.mocked(api.nativeProviderEnqueueTracks).mockClear();
    vi.mocked(api.nativeProviderVideoParts).mockImplementation(async bvid => {
      if (bvid === v1.bvid) return page([v1p1, v1p2]);
      throw new Error("parts read failed");
    });

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText(/收藏夹读取未完成，队列未改变/);
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
  },
);

it("F06: truncates Netease 1001-track playlist and Bilibili 1001-part video to first 1000 items with explicit notice", async () => {
  const playlistRows: ProviderTrack[] = Array.from({ length: 1001 }, (_, i) => ({
    ...song,
    id: `netease:track:${i + 1}`,
    title: `歌单曲目 ${i + 1}`,
  }));
  const expectedTracks = playlistRows.slice(0, 1000);
  const neteaseQueue = { generation: 2, selectedIndex: 0, items: expectedTracks.map(api.providerTrackToQueueTrack) };

  vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), itemCount: playlistRows.length });
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1, size = 50) => ({
    ...page(playlistRows.slice((n - 1) * size, n * size), n * size < playlistRows.length, n),
    total: playlistRows.length,
  }));
  vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(neteaseQueue);
  vi.mocked(nativeQueuePlay).mockResolvedValue({
    requestedQuality: "320k",
    queue: neteaseQueue,
    playback: {
      player: {
        state: "playing",
        generation: 2,
        currentTrack: neteaseQueue.items[0]!,
        positionMs: 0,
        durationMs: 10_000,
        volume: 0.5,
        muted: false,
        failure: null,
      },
      quality: "320k",
      bitrate: 320000,
      expiresInSeconds: 60,
    },
  });

  await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  const playAllBtn = await screen.findByRole("button", { name: "播放全部" });
  await waitFor(() => expect(playAllBtn).toBeEnabled());
  fireEvent.click(playAllBtn);

  await screen.findByText(/已载入 1000 首；已截取前 1000 首/);
  expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith(neteaseQueue.items);
  expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(expectedTracks[0]!.id, 2);

  fireEvent.click(screen.getByRole("button", { name: "全部歌曲加入队列" }));
  await screen.findByText(/1000 首加入队列；已截取前 1000 首/);
  expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith(expectedTracks);

  const partRows: ProviderTrack[] = Array.from({ length: 1001 }, (_, i) => ({
    ...part,
    id: `bilibili:video:BV17x411w7KC:${i + 1}`,
    title: `分 P ${i + 1}`,
    video: { title: video.title, partTitle: `P${i + 1}`, partNumber: i + 1 },
  }));
  const expectedParts = partRows.slice(0, 1000);
  const partsQueue = { generation: 3, selectedIndex: 0, items: expectedParts.map(api.providerTrackToQueueTrack) };

  vi.mocked(api.nativeProviderVideoParts).mockImplementation(async (_bvid, n = 1, size = 100) => ({
    ...page(partRows.slice((n - 1) * size, n * size), n * size < partRows.length, n),
    total: partRows.length,
  }));
  vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue(partsQueue);

  fireEvent.click(within(screen.getByRole("navigation", { name: "音乐来源" })).getByRole("button", { name: "Bilibili" }));
  await screen.findByLabelText("BV/AV 或视频链接");
  fireEvent.change(screen.getByLabelText("BV/AV 或视频链接"), { target: { value: video.bvid } });
  fireEvent.click(screen.getByRole("button", { name: "读取视频分 P" }));
  await screen.findByRole("checkbox", { name: "分 P 1" });
  fireEvent.click(screen.getByRole("button", { name: "全部分 P 加入队列" }));

  await screen.findByText(/1000 个分 P加入队列；已截取前 1000 个分 P/);
  expect(api.nativeProviderEnqueueTracks).toHaveBeenLastCalledWith(expectedParts);
}, 15_000);

describe("readAllProviderPages", () => {
  const makeItems = (count: number, offset = 0): ProviderTrack[] =>
    Array.from({ length: count }, (_, i) => ({
      ...song,
      id: `netease:track:${offset + i + 1}`,
      title: `曲目 ${offset + i + 1}`,
    }));

  it("rejects empty page with hasMore: true on page 2 with IncompleteProviderPageError", async () => {
    const fetchPage = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: makeItems(50), total: 120, hasMore: true }
        : { page: 2, items: [], total: 120, hasMore: true },
    );
    await expect(readAllProviderPages(fetchPage, 50, () => true)).rejects.toMatchObject({
      name: "IncompleteProviderPageError",
      message: "empty_page",
    });
  });

  it("rejects empty page with hasMore: false on page 2 (empty_page)", async () => {
    const fetchPage = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: makeItems(50), total: 120, hasMore: true }
        : { page: 2, items: [], total: 120, hasMore: false },
    );
    await expect(readAllProviderPages(fetchPage, 50, () => true)).rejects.toMatchObject({
      name: "IncompleteProviderPageError",
      message: "empty_page",
    });
  });

  it("rejects mismatched page (page_mismatch) and inconsistent total across pages (total_mismatch)", async () => {
    const mismatchPage = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: makeItems(50), total: 120, hasMore: true }
        : { page: 1, items: makeItems(20, 50), total: 120, hasMore: false },
    );
    await expect(readAllProviderPages(mismatchPage, 50, () => true)).rejects.toMatchObject({
      name: "IncompleteProviderPageError",
      message: "page_mismatch",
    });

    const mismatchTotal = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: makeItems(50), total: 120, hasMore: true }
        : { page: 2, items: makeItems(50, 50), total: 110, hasMore: false },
    );
    await expect(readAllProviderPages(mismatchTotal, 50, () => true)).rejects.toMatchObject({
      name: "IncompleteProviderPageError",
      message: "total_mismatch",
    });
  });

  it("with verifyCompleteTotal: true rejects short_read when items.length < total", async () => {
    const fetchPage = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: makeItems(50), total: 120, hasMore: true }
        : { page: 2, items: makeItems(10, 50), total: 120, hasMore: false },
    );
    await expect(
      readAllProviderPages(fetchPage, 50, () => true, { verifyCompleteTotal: true }),
    ).rejects.toMatchObject({
      name: "IncompleteProviderPageError",
      message: "short_read",
    });
  });

  it("with maxItems: Number.POSITIVE_INFINITY reads >1000 items cleanly without truncated: true", async () => {
    const allItems = makeItems(1050);
    const fetchPage = vi.fn(async (n: number, size: number): Promise<ProviderPage<ProviderTrack>> => ({
      page: n,
      items: allItems.slice((n - 1) * size, n * size),
      total: allItems.length,
      hasMore: n * size < allItems.length,
    }));
    const res = await readAllProviderPages(fetchPage, 50, () => true, {
      maxItems: Number.POSITIVE_INFINITY,
    });
    expect(res.aborted).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.items).toHaveLength(1050);
    expect(res.total).toBe(1050);
    expect(res.items[1004]?.id).toBe("netease:track:1005");
  });

  it("with allowEmptyPages: true accepts filtered empty first, middle, and last pages while preserving total consistency checks", async () => {
    const fetchFiltered = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> => {
      if (n === 1) return { page: 1, items: [], total: 60, hasMore: true };
      if (n === 2) return { page: 2, items: makeItems(15, 20), total: 60, hasMore: true };
      return { page: 3, items: [], total: 60, hasMore: false };
    });
    const res = await readAllProviderPages(fetchFiltered, 20, () => true, { allowEmptyPages: true });
    expect(res.aborted).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.items).toHaveLength(15);
    expect(res.total).toBe(60);

    const mismatchedFiltered = vi.fn(async (n: number): Promise<ProviderPage<ProviderTrack>> =>
      n === 1
        ? { page: 1, items: [], total: 60, hasMore: true }
        : { page: 2, items: makeItems(10), total: 40, hasMore: false },
    );
    await expect(
      readAllProviderPages(mismatchedFiltered, 20, () => true, { allowEmptyPages: true }),
    ).rejects.toMatchObject({ name: "IncompleteProviderPageError", message: "total_mismatch" });
  });

  it("collectBilibiliFolderFirstParts handles filtered empty first or last video pages cleanly", async () => {
    const targetVideo = { ...video, bvid: "BV17x411w7KF", title: "有效收藏视频" };
    const targetPart: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KF:501",
      title: "有效视频 P1",
      video: { title: "有效收藏视频", partTitle: "P1", partNumber: 1 },
    };

    const firstEmpty = await collectBilibiliFolderFirstParts(
      async n =>
        n === 1
          ? { page: 1, items: [], total: 21, hasMore: true }
          : { page: 2, items: [targetVideo], total: 21, hasMore: false },
      async () => page([targetPart]),
      () => true,
      { page: 1, items: [], total: 21, hasMore: true },
    );
    expect(firstEmpty.aborted).toBe(false);
    expect(firstEmpty.tracks).toEqual([targetPart]);

    const lastEmpty = await collectBilibiliFolderFirstParts(
      async n =>
        n === 1
          ? { page: 1, items: [targetVideo], total: 21, hasMore: true }
          : { page: 2, items: [], total: 21, hasMore: false },
      async () => page([targetPart]),
      () => true,
      { page: 1, items: [targetVideo], total: 21, hasMore: true },
    );
    expect(lastEmpty.aborted).toBe(false);
    expect(lastEmpty.tracks).toEqual([targetPart]);
  });
});

it("Comment #2: Default playlist in-list search finds track #1005 across >1000 tracks without truncation", async () => {
  const playlistRows: ProviderTrack[] = Array.from({ length: 1050 }, (_, i) => ({
    ...song,
    id: `netease:track:${i + 1}`,
    title: `歌单曲目 ${i + 1}`,
  }));
  vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), itemCount: playlistRows.length });
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1, size = 50) => ({
    ...page(playlistRows.slice((n - 1) * size, n * size), n * size < playlistRows.length, n),
    total: playlistRows.length,
  }));

  await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  await screen.findByRole("checkbox", { name: "歌单曲目 1" });

  const searchInput = screen.getByPlaceholderText("在此歌单中搜索歌曲、歌手或专辑");
  fireEvent.change(searchInput, { target: { value: "歌单曲目 1005" } });

  await screen.findByRole("checkbox", { name: "歌单曲目 1005" });
  expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();
  expect(api.nativeProviderLibraryTracks).toHaveBeenCalledWith("netease", "netease:playlist:7", 21, 50);
}, 15_000);

it("Comment #2: Default playlist in-list search enters error/retry state when hitting maxPages truncation", async () => {
  const pageItems = Array.from({ length: 50 }, (_, i) => ({
    ...song,
    id: `netease:track:${i + 1}`,
    title: `分页曲目 ${i + 1}`,
  }));
  vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), itemCount: 6000 });
  vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1) => ({
    page: n,
    items: pageItems.map((item, idx) => ({ ...item, id: `netease:track:${(n - 1) * 50 + idx + 1}`, title: `分页曲目 ${(n - 1) * 50 + idx + 1}` })),
    total: 6000,
    hasMore: true,
  }));

  await open("default", "netease");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
  await screen.findByRole("checkbox", { name: "分页曲目 1" });

  const searchInput = screen.getByPlaceholderText("在此歌单中搜索歌曲、歌手或专辑");
  fireEvent.change(searchInput, { target: { value: "分页曲目 5999" } });

  await screen.findByRole("alert");
  expect(screen.getByText("未能读取完整列表，搜索尚未完成")).toBeInTheDocument();
  expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();
  expect(api.nativeProviderLibraryTracks).toHaveBeenCalledWith("netease", "netease:playlist:7", 100, 50);

  const recovered: ProviderTrack = { ...song, id: "netease:track:5999", title: "分页曲目 5999" };
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([recovered]));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("checkbox", { name: "分页曲目 5999" });
}, 15_000);

it.each(["empty_has_more", "short_read"] as const)(
  "Comment #1: enqueueLikes and NetEase container batch enqueue abort queue mutation on %s",
  async mode => {
    const page1Items = Array.from({ length: 100 }, (_, i) => ({
      ...song,
      id: `netease:track:${i + 1}`,
      title: `喜欢曲目 ${i + 1}`,
    }));
    const page2Response = (n: number): ProviderPage<ProviderTrack> =>
      mode === "empty_has_more"
        ? { page: n, items: [], total: 150, hasMore: true }
        : { page: n, items: page1Items.slice(0, 10).map((t, i) => ({ ...t, id: `netease:track:10${i + 1}` })), total: 150, hasMore: false };

    vi.mocked(api.nativeProviderLibraryLikes).mockImplementation(async (_id, n = 1, size = 50) => {
      if (size !== 100) return page([song]);
      return n === 1 ? { page: 1, items: page1Items, total: 150, hasMore: true } : page2Response(n);
    });
    vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1, size = 50) => {
      if (size !== 100) return page([song]);
      return n === 1 ? { page: 1, items: page1Items, total: 150, hasMore: true } : page2Response(n);
    });

    await open("default", "netease");
    fireEvent.click(screen.getByRole("button", { name: "喜欢的歌曲" }));
    await screen.findByRole("checkbox", { name: "网易歌曲" });

    fireEvent.click(screen.getByRole("button", { name: "全部歌曲加入队列" }));
    await screen.findByText(/喜欢歌曲未加入队列/);
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开歌单" }));
    await screen.findByRole("checkbox", { name: "网易歌曲" });

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await screen.findByText(/整单读取未完成，队列未改变/);
    expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
    expect(nativeQueueReplace).not.toHaveBeenCalled();
    expect(nativeQueuePlay).not.toHaveBeenCalled();
  },
);

it("Bilibili favorite folder uses QQ-style table rows, right CURRENT SELECTION inspector, hides global BV/AV bar, and supports batch video play/remove", async () => {
  const v1 = { ...video, bvid: "BV17x411w7KA", title: "收藏视频 A", uploader: "UP 甲" };
  const v2 = { ...video, bvid: "BV17x411w7KB", title: "收藏视频 B", uploader: "UP 乙" };
  const v1p1: ProviderTrack = {
    ...part,
    id: "bilibili:video:BV17x411w7KA:101",
    title: "收藏视频 A",
    artist: "UP 甲",
    video: { title: v1.title, partTitle: "P1", partNumber: 1 },
  };
  const v2p1: ProviderTrack = {
    ...part,
    id: "bilibili:video:BV17x411w7KB:201",
    title: "收藏视频 B",
    artist: "UP 乙",
    video: { title: v2.title, partTitle: "P1", partNumber: 1 },
  };
  const queue = {
    generation: 5,
    selectedIndex: 0,
    items: [v1p1, v2p1].map(api.providerTrackToQueueTrack),
  };

  vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue(page([v1, v2]));
  vi.mocked(api.nativeProviderVideoParts).mockImplementation(async bvid => {
    if (bvid === v1.bvid) return page([v1p1]);
    if (bvid === v2.bvid) return page([v2p1]);
    throw new Error(`unexpected bvid: ${bvid}`);
  });
  vi.mocked(nativeQueuePlay).mockResolvedValue({
    requestedQuality: "320k",
    queue,
    playback: {
      player: {
        state: "playing",
        generation: 5,
        currentTrack: queue.items[0]!,
        positionMs: 0,
        durationMs: 10_000,
        volume: 0.5,
        muted: false,
        failure: null,
      },
      quality: "aac",
      bitrate: 192000,
      expiresInSeconds: 0,
    },
  });

  const view = await open("default", "bilibili");
  fireEvent.click(screen.getByRole("button", { name: "自建" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
  await screen.findByRole("checkbox", { name: "收藏视频 A" });

  const table = view.container.querySelector<HTMLElement>("table.catalog-table");
  expect(table).not.toBeNull();

  // Opened container hides redundant sub-tabs and global BV/AV link bar
  expect(screen.queryByLabelText("BV/AV 或视频链接")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "此来源功能" })).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText("在此收藏夹中搜索视频、UP 主或 BV 号")).toBeInTheDocument();

  // Clicking first video row opens CURRENT SELECTION inspector; clicking second video row updates it
  expect(view.container.querySelector("aside.catalog-inspector")).toBeNull();
  fireEvent.click(within(table!).getByText("收藏视频 A").closest("tr")!);
  const inspector = view.container.querySelector<HTMLElement>("aside.catalog-inspector")!;
  expect(inspector).not.toBeNull();
  expect(within(inspector).getByRole("heading", { name: "收藏视频 A" })).toBeInTheDocument();
  fireEvent.click(within(table!).getByText("收藏视频 B").closest("tr")!);
  expect(within(inspector).getByRole("heading", { name: "收藏视频 B" })).toBeInTheDocument();
  expect(within(inspector).getByRole("button", { name: "添加到收藏夹 / 移出" })).toBeInTheDocument();

  // Select second then first checkbox -> batch play preserves list order [v1, v2]
  fireEvent.click(screen.getByRole("checkbox", { name: "收藏视频 B" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "收藏视频 A" }));
  expect(screen.getByText("已选 2 项")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "播放选中" }));
  await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith(queue.items));
  expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(v1p1.id, 2);

  // Batch remove from current favorite folder sends bilibili:video:<bvid>:1
  fireEvent.click(screen.getByRole("button", { name: "从当前收藏夹移出选中" }));
  await waitFor(() =>
    expect(api.nativeProviderWrite).toHaveBeenCalledWith(
      {
        providerId: "bilibili",
        accountId: "42",
        operation: {
          kind: "removeItems",
          containerId: "bilibili:favorite:7",
          trackIds: ["bilibili:video:BV17x411w7KA:1", "bilibili:video:BV17x411w7KB:1"],
        },
      },
      false,
    ),
  );
});

it.each(["first_page_empty", "last_page_empty"] as const)(
  "Bilibili favorite folder allows play-all, enqueue-all, and search when %s after item filtering (Default & Rhine)",
  async scenario => {
    const validVideo = {
      ...video,
      bvid: "BV17x411w7KG",
      title: "过滤幸存视频",
      uploader: "筛选UP",
    };
    const validPart: ProviderTrack = {
      ...part,
      id: "bilibili:video:BV17x411w7KG:701",
      title: "过滤幸存视频",
      artist: "筛选UP",
      video: { title: validVideo.title, partTitle: "P1", partNumber: 1 },
    };
    const queue = {
      generation: 9,
      selectedIndex: 0,
      items: [api.providerTrackToQueueTrack(validPart)],
    };

    vi.mocked(api.nativeProviderLibraryVideos).mockImplementation(async (_containerId, n = 1) => {
      if (scenario === "first_page_empty") {
        return n === 1
          ? { page: 1, items: [], total: 21, hasMore: true }
          : { page: 2, items: [validVideo], total: 21, hasMore: false };
      }
      return n === 1
        ? { page: 1, items: [validVideo], total: 21, hasMore: true }
        : { page: 2, items: [], total: 21, hasMore: false };
    });
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([validPart]));
    vi.mocked(nativeQueuePlay).mockResolvedValue({
      requestedQuality: "320k",
      queue,
      playback: {
        player: {
          state: "playing",
          generation: 9,
          currentTrack: queue.items[0]!,
          positionMs: 0,
          durationMs: 10_000,
          volume: 0.5,
          muted: false,
          failure: null,
        },
        quality: "aac",
        bitrate: 192000,
        expiresInSeconds: 0,
      },
    });

    const defaultView = await open("default", "bilibili");
    fireEvent.click(screen.getByRole("button", { name: "自建" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开收藏夹" }));
    if (scenario === "first_page_empty") {
      await screen.findByText("此页没有条目");
    } else {
      await screen.findByRole("checkbox", { name: validVideo.title });
    }

    const defaultPlayAll = screen.getByRole("button", { name: "播放全部" });
    const defaultEnqueueAll = screen.getByRole("button", { name: "全部加入队列" });
    expect(defaultPlayAll).toBeEnabled();
    expect(defaultEnqueueAll).toBeEnabled();

    fireEvent.click(defaultEnqueueAll);
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([validPart]));
    expect(nativeQueueReplace).not.toHaveBeenCalled();

    fireEvent.click(defaultPlayAll);
    await waitFor(() => expect(nativeQueueReplace).toHaveBeenCalledExactlyOnceWith(queue.items));
    await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(validPart.id, 2));

    const searchInput = screen.getByPlaceholderText("在此收藏夹中搜索视频、UP 主或 BV 号");
    fireEvent.change(searchInput, { target: { value: "筛选UP" } });
    await screen.findByRole("checkbox", { name: validVideo.title });
    expect(screen.queryByText(/未能读取完整列表/)).not.toBeInTheDocument();
    defaultView.unmount();

    vi.clearAllMocks();
    vi.mocked(api.nativeProviderStatus).mockImplementation(async id => statuses[id as NewProviderId]);
    vi.mocked(api.nativeProviderLibraryContainers).mockImplementation(async id => page([folder(id)]));
    vi.mocked(api.nativeProviderContainer).mockImplementation(async id => folder(id));
    vi.mocked(api.nativeProviderLibraryVideos).mockImplementation(async (_containerId, n = 1) => {
      if (scenario === "first_page_empty") {
        return n === 1
          ? { page: 1, items: [], total: 21, hasMore: true }
          : { page: 2, items: [validVideo], total: 21, hasMore: false };
      }
      return n === 1
        ? { page: 1, items: [validVideo], total: 21, hasMore: true }
        : { page: 2, items: [], total: 21, hasMore: false };
    });
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([validPart]));
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue({
      generation: 1,
      selectedIndex: 0,
      items: queue.items,
    });

    const detail = await openRhinePlaylist("bilibili");
    const rhineSearch = within(detail).getByRole("searchbox", { name: "在歌单内搜索" });
    fireEvent.change(rhineSearch, { target: { value: "筛选UP" } });
    fireEvent.submit(rhineSearch.closest("form")!);
    await within(detail).findByText(validVideo.title);
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();

    const rhineEnqueueAll = within(detail).getByRole("button", { name: "全部加入队列" });
    expect(rhineEnqueueAll).toBeEnabled();
    fireEvent.click(rhineEnqueueAll);
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([validPart]));
  },
  15_000,
);
