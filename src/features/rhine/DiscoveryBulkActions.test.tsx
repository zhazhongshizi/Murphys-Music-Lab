import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CatalogSong } from "../../contracts/catalog";
import type { QueueTrack } from "../../contracts/queue";
import { ArchiveDiscovery } from "./ArchiveDiscovery";

const mocks = vi.hoisted(() => ({ songs: vi.fn(), start: vi.fn(), hydrateSession: vi.fn(), replace: vi.fn(), append: vi.fn(), hydrate: vi.fn(), play: vi.fn() }));
vi.mock("../../backend/catalogDiscoveryAdapter", () => ({ getRecommendedSongs: mocks.songs, getRecommendedPlaylists: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeStartRadar: mocks.start, nativeQueueReplace: mocks.replace, nativeQueueEnqueueMany: mocks.append }));
vi.mock("../../backend/playbackTransport", () => ({ playbackSessionIdentity: () => "local" }));
vi.mock("../player/playerStore", () => ({ playerActions: { hydrateNative: mocks.hydrate, hydrateNativeSession: mocks.hydrateSession, playTrack: mocks.play } }));
vi.mock("../catalog/CatalogDetails", () => ({ CatalogDetails: () => null, AlbumLink: () => null }));

const songs: CatalogSong[] = Array.from({ length: 20 }, (_, index) => ({
  id: `song-${index + 1}`, title: `推荐 ${index + 1}`, artist: "歌手", artists: [], album: "专辑", subtitle: "",
  durationMs: 180000, qualityCandidates: [], availability: { status: "unknown", requiresSubscription: false },
}));
const previous: QueueTrack = { id: "old", title: "原队列歌曲", artist: "原歌手", album: "", durationMs: 1000 };
let queue: QueueTrack[], order: string[];
const props = { active: true, accountKey: "authenticated:a", onClose: vi.fn(), onDeck: vi.fn() };
const snapshot = () => ({ generation: 1, selectedIndex: queue.length ? 0 : null, items: queue });
beforeEach(() => {
  vi.resetAllMocks(); queue = [previous]; order = [];
  mocks.songs.mockImplementation(async (kind: string, generation: number, page: number) => ({
    generation, page, hasMore: kind === "radar" && page === 1, warningCount: 0,
    items: kind === "guess" ? songs : page === 1 ? songs.slice(0, 10) : [songs[0], ...songs.slice(10)],
  }));
  mocks.append.mockImplementation(async (items: QueueTrack[]) => { order.push("append"); queue = [...queue, ...items]; return snapshot(); });
  mocks.replace.mockImplementation(async (items: QueueTrack[]) => { order.push("replace"); queue = items; return snapshot(); });
  mocks.hydrate.mockImplementation(async () => { order.push("hydrate"); });
  mocks.play.mockImplementation(async () => { order.push("play"); return true; });
  mocks.start.mockImplementation(async ({ items }: { items: QueueTrack[] }) => { order.push("radar"); queue = items.slice(0, 10); return { queue: snapshot() }; });
  mocks.hydrateSession.mockImplementation(async () => { order.push("hydrate-session"); });
});
afterEach(cleanup);
async function openRadar() {
  fireEvent.click(screen.getByRole("button", { name: "雷达推荐" }));
  const button = screen.getByRole("button", { name: "播放雷达推荐" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

it("appends all guess recommendations across visual pages without clearing or playing", async () => {
  render(<ArchiveDiscovery {...props}/>);
  const button = screen.getByRole("button", { name: "全部添加进播放列表中" });
  expect(button).toBeDisabled();
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText("已将全部 20 首推荐加入播放列表");
  expect(queue.map(song => song.id)).toEqual(["old", ...songs.map(song => song.id)]);
  expect(order).toEqual(["append", "hydrate"]);
  expect(mocks.songs).toHaveBeenCalledOnce();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.play).not.toHaveBeenCalled();
  expect(props.onDeck).not.toHaveBeenCalled();
});

it("starts radar in shelf order, including the tenth song not yet shown on the shelf", async () => {
  const firstBatch = [...songs.slice(0, 10)].reverse();
  mocks.songs.mockImplementation(async (kind: string, generation: number, page: number) => ({
    generation, page, hasMore: kind === "radar", warningCount: 0,
    items: kind === "radar" ? firstBatch : songs,
  }));
  render(<ArchiveDiscovery {...props}/>);
  await openRadar();
  expect(screen.getAllByRole("button", { name: /选择歌曲 推荐/ }).map(button => button.getAttribute("aria-label")))
    .toEqual(firstBatch.slice(0, 9).map(song => `选择歌曲 ${song.title}`));
  fireEvent.click(screen.getByRole("button", { name: "播放雷达推荐" }));
  await waitFor(() => expect(props.onDeck).toHaveBeenCalledOnce());
  expect(queue.map(song => song.id)).toEqual(firstBatch.map(song => song.id));
  expect(order).toEqual(["radar", "hydrate-session"]);
  expect(mocks.start).toHaveBeenCalledWith({
    items: firstBatch.map(song => expect.objectContaining({ id: song.id })), sourcePage: 1, hasMore: true,
  });
  expect(mocks.play).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(mocks.songs.mock.calls.filter(call => call[0] === "radar")).toHaveLength(1);
});

it("reports a failed native start without navigating or replaying the request", async () => {
  render(<ArchiveDiscovery {...props}/>);
  const button = await openRadar();
  mocks.start.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(button);
  await screen.findByText("雷达播放未能启动，请检查播放器后重试");
  expect(queue).toEqual([previous]);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.play).not.toHaveBeenCalled();
  expect(props.onDeck).not.toHaveBeenCalled();
});

it.each(["leave", "account"])("ignores repeated clicks and stale native results after %s", async change => {
  const view = render(<ArchiveDiscovery {...props}/>);
  const button = await openRadar();
  let finish!: (value: unknown) => void;
  mocks.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(button).toBeDisabled();
  expect(screen.getByRole("button", { name: "刷新推荐" })).toBeDisabled();
  view.rerender(<ArchiveDiscovery {...props} active={change !== "leave"} accountKey={change === "account" ? "authenticated:b" : props.accountKey}/>);
  await act(async () => finish({ queue: snapshot() }));
  expect(queue).toEqual([previous]);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(props.onDeck).not.toHaveBeenCalled();
  expect(mocks.hydrateSession).not.toHaveBeenCalled();
});

it("reports playback failure after queue replacement and stays on the discovery page", async () => {
  render(<ArchiveDiscovery {...props}/>);
  const button = await openRadar();
  mocks.start.mockImplementationOnce(async () => { queue = songs.slice(0, 10); throw new Error("playback failed"); });
  fireEvent.click(button);
  await screen.findByText("雷达播放未能启动，请检查播放器后重试");
  expect(queue.map(song => song.id)).toEqual(songs.slice(0, 10).map(song => song.id));
  expect(props.onDeck).not.toHaveBeenCalled();
});

it("disables bulk actions for empty recommendations", async () => {
  mocks.songs.mockImplementation(async (_kind: string, generation: number) => ({ generation, page: 1, hasMore: false, warningCount: 0, items: [] }));
  render(<ArchiveDiscovery {...props}/>);
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
  expect(screen.getByRole("button", { name: "全部添加进播放列表中" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "雷达推荐" }));
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
  expect(screen.getByRole("button", { name: "播放雷达推荐" })).toBeDisabled();
  expect(order).toEqual([]);
});
