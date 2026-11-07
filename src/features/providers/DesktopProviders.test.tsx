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
import { SourceBadge } from "./SourceBadge";
import { playerActions } from "../player/playerStore";
import { nativeQueueEnqueueNext, nativeQueuePlay } from "../../backend/nativeQueueAdapter";

vi.mock("../../backend/providersAdapter", async original => ({
  ...await original<typeof import("../../backend/providersAdapter")>(),
  nativeProviderStatus: vi.fn(), nativeProviderLogin: vi.fn(), nativeProviderPoll: vi.fn(), nativeProviderCancel: vi.fn(), nativeProviderRestore: vi.fn(), nativeProviderLogout: vi.fn(), nativeProviderCheck: vi.fn(),
  nativeProviderSearchSongs: vi.fn(), nativeProviderSearchPlaylists: vi.fn(), nativeProviderSearchVideos: vi.fn(), nativeProviderLibraryContainers: vi.fn(), nativeProviderLibraryTracks: vi.fn(), nativeProviderLibraryVideos: vi.fn(), nativeProviderLibraryLikes: vi.fn(), nativeProviderContainer: vi.fn(), nativeProviderResolveVideo: vi.fn(), nativeProviderVideoParts: vi.fn(), nativeProviderEnqueueTracks: vi.fn(), nativeProviderEnqueueVideo: vi.fn(), nativeProviderWrite: vi.fn(),
}));
vi.mock("../player/playerStore", () => ({ playerActions: { hydrateNative: vi.fn(), refreshProviderLikes: vi.fn(), applyVerifiedProviderLike: vi.fn() } }));
vi.mock("../../backend/nativeQueueAdapter", async original => ({ ...await original<typeof import("../../backend/nativeQueueAdapter")>(), nativeQueuePlay: vi.fn(), nativeQueueEnqueueNext: vi.fn() }));

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
  vi.mocked(nativeQueueEnqueueNext).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [api.providerTrackToQueueTrack(song)] });
  vi.mocked(api.nativeProviderWrite).mockResolvedValue({ status: "applied", affectedCount: null });
  vi.mocked(api.nativeProviderCancel).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); installPlaybackTransport(null); });
function Harness({ variant, onScene }: { variant: "default" | "rhine"; onScene?: (scene: RhineProviderSceneState) => void }) {
  const [account, setAccount] = useState(false);
  const [section, setSection] = useState<"created" | "favorite" | "search">("search");
  const { source, refresh } = useDesktopProviders();
  return <>{variant === "rhine" && <nav aria-label="档案分类"><button onClick={() => setSection("created")}>自建</button><button onClick={() => setSection("favorite")}>收藏</button><button onClick={() => setSection("search")}>搜索</button></nav>}<SourceNavigation variant={variant} onAccount={() => setAccount(true)} /><button onClick={() => { if (source === "netease" || source === "bilibili") void refresh(source); }}>刷新测试会话</button><ProviderWorkspace variant={variant} initialSection={section} onArchive={() => setSection("created")} onAccount={() => setAccount(true)} onRhineSceneChange={onScene} />{account && <DesktopAccountDialog variant={variant} auth={{ state: "signedOut" }} onAuthChange={() => {}} onClose={() => setAccount(false)} />}</>;
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
    fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
    const check = await screen.findByRole("checkbox", { name: "网易歌曲" }); fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "从当前容器移出选中" }));
    await screen.findByText(/结果待核对，可能部分完成/);
    expect(screen.getByRole("button", { name: "从当前容器移出选中" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "只读核对结果" }));
    await waitFor(() => expect(api.nativeProviderWrite).toHaveBeenLastCalledWith({ providerId: "netease", accountId: "42", operation: { kind: "removeItems", containerId: "netease:playlist:7", trackIds: [song.id] } }, true));
    expect(api.nativeProviderWrite).toHaveBeenCalledTimes(2);
  });
  it("a collected container never enables content removal even when the source supports writes", async () => {
    vi.mocked(api.nativeProviderContainer).mockResolvedValue({ ...folder("netease"), ownership: "collected", owner: { providerId: "netease", id: "99" }, allowedActions: ["playlist.subscribe", "playlist.unsubscribe"] });
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "自建" })); fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "网易歌曲" }));
    expect(screen.getByRole("button", { name: "从当前容器移出选中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "收藏此歌单" })).toBeEnabled(); expect(api.nativeProviderWrite).not.toHaveBeenCalled();
  });
  it("capabilities hide unsupported library kinds and disable unsupported mutations", async () => {
    const status = ready("netease"); statuses.netease = { ...status, capabilities: { ...status.capabilities, libraryKinds: [], writeActions: [], searchKinds: ["songs"] } };
    await open(variant);
    const workspace = within(screen.getByRole("region", { name: "网易云曲库" }));
    expect(workspace.queryByRole("button", { name: "喜欢的歌曲" })).not.toBeInTheDocument(); expect(workspace.queryByRole("button", { name: "自建" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: "歌曲" } }); fireEvent.click(screen.getByRole("button", { name: "搜索此来源" }));
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
    return screen.findByRole("button", { name: "播放视频" });
  }
  it.each([true, false])("single-part video acts directly without a part picker (play=%s)", async play => {
    const single: ProviderTrack = { ...part, video: { ...part.video!, partNumber: 1 } };
    vi.mocked(api.nativeProviderVideoParts).mockResolvedValue(page([single]));
    vi.mocked(api.nativeProviderEnqueueTracks).mockResolvedValue({ generation: 1, selectedIndex: 0, items: [single] });
    await searchVideo();
    fireEvent.click(screen.getByRole("button", { name: play ? "播放视频" : "加入队列" }));
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([single]));
    if (play) await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(single.id, 1));
    else expect(nativeQueuePlay).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "全部分 P 加入队列" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放视频" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
    fireEvent.click(await screen.findByRole("button", { name: "播放视频" }));
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
    expect(screen.getByRole("button", { name: "播放视频" })).toBeEnabled();
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
  it("whole playlist collection is bounded and commits once after complete pagination", async () => {
    vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _c, n = 1, size) => size === 100 ? { ...page([n === 1 ? song : { ...song, id: "netease:track:2", title: "第二首" }], n === 1, n), total: 2 } : page([song]));
    await open(variant); fireEvent.click(screen.getByRole("button", { name: "自建" })); fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
    const enqueueAll = await screen.findByRole("button", { name: "全部歌曲加入队列" });
    await waitFor(() => expect(enqueueAll).toBeEnabled());
    fireEvent.click(enqueueAll);
    await waitFor(() => expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledTimes(1)); expect(vi.mocked(api.nativeProviderEnqueueTracks).mock.calls[0]![0]).toHaveLength(2);
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
    await screen.findByRole("button", { name: "打开此容器" });
    if (variant === "default") {
      expect(view.container.querySelector(".catalog-pane")).not.toBeNull();
      expect(view.container.querySelector(".catalog-inspector")).not.toBeNull();
      expect(view.container.querySelector(".playlist-grid .playlist-card")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "打开此容器" }));
      await screen.findByRole("checkbox", { name: "网易歌曲" });
      expect(view.container.querySelector("table.catalog-table")).not.toBeNull();
    } else {
      expect(view.container.querySelector(".rhine-provider-bar")).toBeNull();
      expect(view.container.querySelector(".rhine-selection")).not.toBeNull();
      expect(view.container.querySelector(".rhine-catalog .rhine-card-list")).not.toBeNull();
      await waitFor(() =>
        expect(scenes.at(-1)).toMatchObject({ titles: ["自建容器"], selected: 0, detail: false, searchMode: false }),
      );
      fireEvent.click(screen.getByRole("button", { name: "打开此容器" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
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
  fireEvent.click(screen.getByRole("button", { name: "← 返回档案" }));
  await screen.findByRole("button", { name: "打开此容器" });
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
  fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
  fireEvent.click(await screen.findByRole("button", { name: "播放视频" }));
  await screen.findByRole("button", { name: "全部分 P 加入队列" });
  expect(screen.queryByRole("button", { name: "返回视频列表" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "自建容器" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "← 返回档案" }));
  await screen.findByRole("button", { name: "返回容器列表" });
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
  fireEvent.click(await screen.findByRole("button", { name: "打开此容器" }));
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
  fireEvent.click(within(detail).getByRole("checkbox", { name: "全选本页" }));
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
  expect(within(detail).queryByRole("button", { name: "从当前容器移出选中" })).not.toBeInTheDocument();
  expect(api.nativeProviderSearchVideos).not.toHaveBeenCalled();
  fireEvent.click(within(detail).getByRole("button", { name: "播放视频" }));
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
  expect(within(detail).queryByRole("button", { name: "播放此项" })).not.toBeInTheDocument();
  vi.mocked(api.nativeProviderLibraryTracks).mockResolvedValue(page([song]));
  fireEvent.click(within(detail).getByRole("button", { name: "重试" }));
  await within(detail).findByText("网易歌曲");
  expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
});
it("Rhine Netease play-all reads the complete playlist once before starting its first track", async () => {
  const detail = await openRhinePlaylist("netease");
  const button = await within(detail).findByRole("button", { name: "播放全部" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(nativeQueuePlay).toHaveBeenCalledExactlyOnceWith(song.id, 1));
  expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledExactlyOnceWith([song]);
});

it.each(["read", "enqueue", "hydrate"] as const)("leaving a playlist cancels play-all after %s and releases its busy state", async phase => {
  const detail = await openRhinePlaylist("netease");
  const button = await within(detail).findByRole("button", { name: "播放全部" });
  await waitFor(() => expect(button).toBeEnabled());
  const gate = deferred<void>();
  const queue = { generation: 1, selectedIndex: 0, items: [api.providerTrackToQueueTrack(song)] };
  if (phase === "read") vi.mocked(api.nativeProviderLibraryTracks).mockImplementation(async (_id, _container, _page, size) => {
    if (size === 100) await gate.promise;
    return page([song]);
  });
  if (phase === "enqueue") vi.mocked(api.nativeProviderEnqueueTracks).mockImplementation(async () => { await gate.promise; return queue; });
  if (phase === "hydrate") vi.mocked(playerActions.hydrateNative).mockImplementation(async () => { await gate.promise; });
  fireEvent.click(button);
  await waitFor(() => {
    if (phase === "read") expect(api.nativeProviderLibraryTracks).toHaveBeenCalledWith("netease", "netease:playlist:7", 1, 100);
    else if (phase === "enqueue") expect(api.nativeProviderEnqueueTracks).toHaveBeenCalledTimes(1);
    else expect(playerActions.hydrateNative).toHaveBeenCalledTimes(1);
  });
  fireEvent.click(within(detail).getByRole("button", { name: "返回容器列表" }));
  await screen.findByRole("button", { name: "打开此容器" });
  await act(async () => { gate.resolve(); });
  expect(nativeQueuePlay).not.toHaveBeenCalled();
  if (phase === "read") expect(api.nativeProviderEnqueueTracks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开此容器" }));
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
