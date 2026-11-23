import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecommendationPanel } from "./RecommendationPanel";
const mocks = vi.hoisted(() => ({
  songs: vi.fn(), lists: vi.fn(), play: vi.fn(), next: vi.fn(), enqueue: vi.fn(),
  enqueueMany: vi.fn(), startRadar: vi.fn(), hydrateSession: vi.fn(),
}));
vi.mock("../../backend/catalogDiscoveryAdapter", () => ({
  getRecommendedSongs: mocks.songs, getRecommendedPlaylists: mocks.lists,
}));
vi.mock("../player/catalogQueue", async importOriginal => ({
  ...await importOriginal<typeof import("../player/catalogQueue")>(),
  enqueueAndPlayCatalogTrack: mocks.play, enqueueNextCatalogTrack: mocks.next, enqueueCatalogTrack: mocks.enqueue,
  enqueueCatalogTracks: mocks.enqueueMany,
}));
vi.mock("../../backend/nativeQueueAdapter", () => ({
  nativeStartRadar: mocks.startRadar,
}));
vi.mock("../player/playerStore", () => ({
  playerActions: { hydrateNativeSession: mocks.hydrateSession },
}));
vi.mock("../stage/AlbumArtwork", () => ({ AlbumArtwork: () => <span /> }));
const song = { id: "song-1", title: "推荐曲目", subtitle: "", artists: [{ id: "artist-1", name: "歌手" }],
  artist: "歌手", album: "专辑", durationMs: 180000, qualityCandidates: [],
  availability: { status: "unknown", requiresSubscription: false } };
const followupSongs = Array.from({ length: 10 }, (_, index) => ({
  ...song, id: `followup-${index + 1}`, title: `后续雷达曲目 ${index + 1}`,
}));
const playlist = { kind: "playlist", id: "123", title: "推荐歌单一", description: "安静的旋律", songCount: 20, listenCount: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.songs.mockImplementation((kind: string, generation: number, page: number) =>
    Promise.resolve({ generation, page, hasMore: kind !== "radar", warningCount: 0, items: [song] }));
  mocks.lists.mockImplementation((generation: number, page: number) =>
    Promise.resolve({ generation, page, hasMore: false, warningCount: 0, items: [playlist] }));
  mocks.play.mockResolvedValue(undefined); mocks.next.mockResolvedValue(undefined); mocks.enqueue.mockResolvedValue(undefined);
  mocks.enqueueMany.mockResolvedValue(undefined);
  mocks.startRadar.mockResolvedValue({ queue: { items: [song] } });
  mocks.hydrateSession.mockResolvedValue(undefined);
});
afterEach(cleanup);
it("retains a named song credit as text and keeps the profiled artist link",async()=>{
 const credited={...song,artists:[{id:"0",name:"未建主页的署名"},...song.artists],artist:"未建主页的署名 / 歌手"};
 mocks.songs.mockImplementation((_kind:string,generation:number)=>Promise.resolve({generation,page:1,hasMore:false,warningCount:0,items:[credited]}));
 const open=vi.fn();render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={open}/>);
 await screen.findByText("推荐曲目");expect(screen.getByText("未建主页的署名")).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"未建主页的署名"})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"歌手"}));expect(open).toHaveBeenCalledWith({kind:"artist",...song.artists[0]});
});
it("loads guessed songs and supports play, enqueue-next and refresh", async () => {
  render(<RecommendationPanel kind="guess" accountKey="authenticated:a" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "播放 推荐曲目" }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(song));
  fireEvent.click(screen.getByRole("button", { name: "下一首播放 推荐曲目" }));
  await waitFor(() => expect(mocks.next).toHaveBeenCalledWith(song));
  expect(screen.queryByRole("navigation", { name: "推荐分页" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await waitFor(() => expect(mocks.songs).toHaveBeenCalledTimes(2));
});
it("paginates radar recommendations and opens recommended playlist details", async () => {
  mocks.songs.mockImplementationOnce(async (_, generation) => ({
    generation, page: 1, hasMore: true, warningCount: 0, items: followupSongs,
  }));
  const open = vi.fn(); const view = render(<RecommendationPanel kind="radar" accountKey="signedOut:guest" onOpen={open} />);
  await screen.findByText(followupSongs[0]!.title); fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(mocks.songs).toHaveBeenLastCalledWith("radar", expect.any(Number), 2));
  view.rerender(<RecommendationPanel key="playlists" kind="playlists" accountKey="signedOut:guest" onOpen={open} />);
  fireEvent.click(await screen.findByRole("button", { name: /推荐歌单一/ }));
  expect(open).toHaveBeenCalledWith(playlist);
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
});
it("fills radar's first page after a one-song batch and carries overflow to the next page", async () => {
  mocks.songs.mockImplementationOnce(async (_, generation) => ({
    generation, page: 1, hasMore: true, warningCount: 0, items: [song],
  })).mockImplementationOnce(async (_, generation) => ({
    generation, page: 2, hasMore: false, warningCount: 0, items: followupSongs,
  }));
  render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={() => {}} />);
  const lastOnFirstPage = followupSongs[8]!.title;
  const overflow = followupSongs[9]!.title;
  await screen.findByText(lastOnFirstPage);
  expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(10);
  expect(screen.getByText(song.title)).toBeInTheDocument();
  expect(screen.queryByText(overflow)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText(overflow);
  expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText(lastOnFirstPage);
  expect(mocks.songs).toHaveBeenCalledTimes(2);
});
it("ignores old pages and stops fetching while inactive", async () => {
  let finish!: (value: unknown) => void;
  mocks.songs.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={() => {}} />);
  await waitFor(() => expect(mocks.songs).toHaveBeenCalledTimes(1));
  view.rerender(<RecommendationPanel key="account-b" kind="radar" accountKey="authenticated:b" onOpen={() => {}} />);
  await screen.findByText("推荐曲目");
  await act(async () => finish({ generation: 1, page: 1, hasMore: true, warningCount: 0, items: [{ ...song, title: "旧账号结果" }] }));
  expect(screen.queryByText("旧账号结果")).not.toBeInTheDocument();
  view.rerender(<RecommendationPanel key="account-b" kind="radar" accountKey="authenticated:b" active={false} onOpen={() => {}} />);
  expect(mocks.songs).toHaveBeenCalledTimes(2);
});
it("shows failure and empty states without inventing recommendations", async () => {
  mocks.songs.mockRejectedValueOnce(new Error("unavailable"));
  render(<RecommendationPanel kind="guess" accountKey="signedOut:guest" onOpen={() => {}} />);
  await screen.findByRole("alert");
  mocks.songs.mockImplementation((_kind: string, generation: number) => Promise.resolve({ generation, page: 1, hasMore: false, warningCount: 0, items: [] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
});
it("supports bulk radar playback and disables the action when empty", async () => {
  render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={() => {}} />);
  const radarBtn = await screen.findByRole("button", { name: "播放雷达推荐" });
  expect(radarBtn).not.toBeDisabled();
  fireEvent.click(radarBtn);
  await waitFor(() => expect(mocks.startRadar).toHaveBeenCalledTimes(1));
  expect(mocks.startRadar).toHaveBeenCalledWith({ items: [expect.objectContaining({ id: song.id })], sourcePage: 1, hasMore: false });
  expect(mocks.hydrateSession).toHaveBeenCalledWith({ queue: { items: [song] } });
  expect(await screen.findByText("已载入 1 首雷达推荐并开始播放")).toBeInTheDocument();

  mocks.songs.mockImplementation((_kind: string, generation: number) =>
    Promise.resolve({ generation, page: 1, hasMore: false, warningCount: 0, items: [] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
  expect(screen.getByRole("button", { name: "播放雷达推荐" })).toBeDisabled();
});
it("starts with the displayed order across loaded pages and discards that order on refresh", async () => {
  const second = { ...song, id: "song-2", title: "后续推荐" };
  const first = { ...song, id: "song-3", title: "首条推荐" };
  const refreshed = { ...song, id: "song-4", title: "刷新后推荐" };
  const firstPage = [first, song, ...followupSongs.slice(0, 8)];
  mocks.songs.mockImplementationOnce(async (_, generation) => ({ generation, page: 1, hasMore: true, warningCount: 0, items: firstPage }))
    .mockImplementationOnce(async (_, generation) => ({ generation, page: 2, hasMore: false, warningCount: 0, items: [second, first] }))
    .mockImplementationOnce(async (_, generation) => ({ generation, page: 1, hasMore: false, warningCount: 0, items: [refreshed] }));
  render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={() => {}} />);
  await screen.findByText(first.title);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText(second.title);
  fireEvent.click(screen.getByRole("button", { name: "播放雷达推荐" }));
  expect(mocks.startRadar).toHaveBeenLastCalledWith({
    items: [...firstPage, second].map(item => expect.objectContaining({ id: item.id })), sourcePage: 2, hasMore: false,
  });
  expect(mocks.songs).toHaveBeenCalledTimes(2);
  await screen.findByText("已载入 1 首雷达推荐并开始播放");
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await screen.findByText(refreshed.title);
  fireEvent.click(screen.getByRole("button", { name: "播放雷达推荐" }));
  expect(mocks.songs).toHaveBeenLastCalledWith("radar", expect.any(Number), 1);
  expect(mocks.startRadar).toHaveBeenLastCalledWith({
    items: [expect.objectContaining({ id: refreshed.id })], sourcePage: 1, hasMore: false,
  });
});
it("supports appending all guessed songs to the playback queue", async () => {
  render(<RecommendationPanel kind="guess" accountKey="authenticated:a" onOpen={() => {}} />);
  const addAllBtn = await screen.findByRole("button", { name: "全部添加进播放列表中" });
  expect(addAllBtn).not.toBeDisabled();
  fireEvent.click(addAllBtn);
  await waitFor(() => expect(mocks.enqueueMany).toHaveBeenCalledWith([song]));
  expect(await screen.findByText("已将全部 1 首推荐加入播放列表")).toBeInTheDocument();
});
