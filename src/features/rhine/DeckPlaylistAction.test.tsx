import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addSongsToPlaylist, getLibraryPlaylists, LibraryAdapterError } from "../../backend/libraryAdapter";
import { installPlaybackTransport } from "../../backend/playbackTransport";
import type { PlaylistPage } from "../../contracts/library";
import { PlayerBar } from "../player/PlayerBar";
import { resetPlayerFixture } from "../player/playerStore";
import { DeckPlaylistAction } from "./DeckPlaylistAction";

vi.mock("../../backend/libraryAdapter", async importOriginal => ({
  ...await importOriginal<typeof import("../../backend/libraryAdapter")>(),
  getLibraryPlaylists: vi.fn(),
  addSongsToPlaylist: vi.fn(),
}));

const track = { id: "songA", title: "雷达歌曲 A" };
const firstPage: PlaylistPage = {
  kind: "created", page: 1, hasMore: false, total: 2, warningCount: 0,
  items: [
    { id: "101", editableId: "201", title: "工作", description: "", songCount: 3 },
    { id: "102", editableId: "202", title: "夜航", description: "", songCount: 4 },
  ],
};
beforeEach(() => {
  vi.mocked(getLibraryPlaylists).mockResolvedValue(firstPage);
  vi.mocked(addSongsToPlaylist).mockResolvedValue({ status: "applied" });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  installPlaybackTransport(null);
});

it("点击才读取歌单；切歌后仍将点击时的歌曲加入选定歌单，只提交一次", async () => {
  const user = userEvent.setup();
  const view = render(<DeckPlaylistAction track={track} />);
  expect(getLibraryPlaylists).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "将歌曲添加进歌单" }));
  expect(getLibraryPlaylists).toHaveBeenCalledExactlyOnceWith("created", 1, 50);
  await user.click(await screen.findByRole("combobox", { name: "目标歌单：工作" }));
  await user.click(screen.getByRole("option", { name: "夜航" }));
  view.rerender(<DeckPlaylistAction track={{ id: "songB", title: "雷达歌曲 B" }} />);
  await user.click(screen.getByRole("button", { name: "确认添加" }));
  expect(addSongsToPlaylist).toHaveBeenCalledExactlyOnceWith("102", "202", ["songA"]);
  expect(await screen.findByRole("status")).toHaveTextContent("已将“雷达歌曲 A”加入“夜航”");
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
});

it("歌单按需翻页，关闭再打开时不使用上次的迟到结果", async () => {
  let resolve!: (value: PlaylistPage) => void;
  vi.mocked(getLibraryPlaylists).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = userEvent.setup();
  render(<DeckPlaylistAction track={track} />);
  await user.click(screen.getByRole("button", { name: "将歌曲添加进歌单" }));
  await user.click(screen.getByRole("button", { name: "关闭添加歌单" }));
  vi.mocked(getLibraryPlaylists).mockResolvedValueOnce({ ...firstPage, hasMore: true });
  await user.click(screen.getByRole("button", { name: "将歌曲添加进歌单" }));
  await screen.findByRole("combobox", { name: "目标歌单：工作" });
  await act(async () => resolve({ ...firstPage, items: [], hasMore: false }));
  expect(getLibraryPlaylists).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "更多歌单" }));
  await waitFor(() => expect(getLibraryPlaylists).toHaveBeenLastCalledWith("created", 2, 50));
  expect(screen.getByRole("combobox", { name: "目标歌单：工作" })).toBeInTheDocument();
});

it("空歌单无法提交；读取失败可显式重试", async () => {
  vi.mocked(getLibraryPlaylists).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...firstPage, items: [] });
  const user = userEvent.setup();
  render(<DeckPlaylistAction track={track} />);
  await user.click(screen.getByRole("button", { name: "将歌曲添加进歌单" }));
  await user.click(await screen.findByRole("button", { name: "重新读取歌单" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("还没有可添加的歌单"));
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  expect(addSongsToPlaylist).not.toHaveBeenCalled();
});

it("写入结果未知时提示核对，不自动重放写请求", async () => {
  vi.mocked(addSongsToPlaylist).mockRejectedValue(new LibraryAdapterError("QMG-LIBRARY-UNKNOWN"));
  const user = userEvent.setup();
  render(<DeckPlaylistAction track={track} />);
  await user.click(screen.getByRole("button", { name: "将歌曲添加进歌单" }));
  await screen.findByRole("combobox", { name: "目标歌单：工作" });
  await user.click(screen.getByRole("button", { name: "确认添加" }));
  expect(screen.getByRole("status")).toHaveTextContent("加入结果待核对");
  expect(addSongsToPlaylist).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
});

it("Escape 关闭并恢复焦点；账号变化丢弃原先选择", async () => {
  const user = userEvent.setup();
  const view = render(<DeckPlaylistAction key="accountA" track={track} />);
  const trigger = screen.getByRole("button", { name: "将歌曲添加进歌单" });
  await user.click(trigger);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  view.rerender(<DeckPlaylistAction key="accountB" track={track} authenticated={false} />);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "将歌曲添加进歌单" })).toBeDisabled();
});

it.each([undefined, { id: `local_${"a".repeat(64)}_flac`, title: "本地歌" }])("无在线歌曲时禁用入口", song => {
  render(<DeckPlaylistAction track={song} />);
  expect(screen.getByRole("button", { name: "将歌曲添加进歌单" })).toBeDisabled();
  expect(getLibraryPlaylists).not.toHaveBeenCalled();
});

it("variant='default' 渲染 .provider-library-trigger 且在网易歌曲时只展示 ProviderLibraryActions", async () => {
  const user = userEvent.setup();
  const qqTrack = { id: "songA", title: "雷达歌曲 A" };
  const view = render(<DeckPlaylistAction track={qqTrack} variant="default" />);

  const trigger = screen.getByRole("button", { name: "将歌曲添加进歌单" });
  expect(trigger).toHaveClass("provider-library-trigger");

  await user.click(trigger);
  expect(getLibraryPlaylists).toHaveBeenCalledExactlyOnceWith("created", 1, 50);

  const form = document.querySelector(".provider-library-form");
  expect(form).toBeInTheDocument();

  await screen.findByRole("combobox", { name: "目标歌单：工作" });
  const confirmBtn = screen.getByRole("button", { name: "确认添加" });
  expect(confirmBtn).toHaveClass("text-button", "text-button--primary");
  await user.click(confirmBtn);

  expect(addSongsToPlaylist).toHaveBeenCalledExactlyOnceWith("101", "201", ["songA"]);
  const status = await screen.findByRole("status");
  expect(status).toHaveClass("provider-library-status");
  expect(status).toHaveTextContent("已将“雷达歌曲 A”加入“工作”");

  view.rerender(<DeckPlaylistAction track={{ id: "netease:track:2", title: "网易歌曲" }} variant="default" />);
  expect(screen.queryByRole("button", { name: "将歌曲添加进歌单" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "网易喜欢 / 歌单操作" })).toBeInTheDocument();
});

it("远端播放时隐藏添加歌单入口", () => {
  installPlaybackTransport(() => Promise.resolve());
  const { container } = render(<DeckPlaylistAction track={track} />);
  expect(container.firstChild).toBeNull();
});

it("主界面底部播放栏播放 QQ 音乐歌曲时展示将歌曲添加进歌单按钮", async () => {
  resetPlayerFixture();
  const user = userEvent.setup();
  render(<PlayerBar onOpenQueue={() => {}} queueOpen={false} />);
  const trigger = screen.getByRole("button", { name: "将歌曲添加进歌单" });
  expect(trigger.closest(".player-bar__library")).not.toBeNull();
  await user.click(trigger);
  expect(getLibraryPlaylists).toHaveBeenCalledExactlyOnceWith("created", 1, 50);
  expect(await screen.findByRole("combobox", { name: "目标歌单：工作" })).toBeInTheDocument();
});
