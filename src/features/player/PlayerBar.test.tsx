import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import constants from "../../../contracts/protocol-v2.constants.json";
import { getSongArtists } from "../../backend/artistAdapter";
import { getLikedSongs } from "../../backend/libraryAdapter";
import { nativeProviderLikes, nativeProviderStatus } from "../../backend/providersAdapter";
import { invalidateProviderSession } from "../../backend/providerSessions";
import type { PlayerSnapshot as NativePlayerSnapshot } from "../../contracts/appSnapshot";
import type { ProviderCapabilities } from "../../contracts/providers";
import type { QueueSnapshot } from "../../contracts/queue";
import { ArtistNavigationContext } from "../artist/ArtistNavigation";
import { PlayerBar } from "./PlayerBar";
import { playerActions, resetPlayerFixture } from "./playerStore";

vi.mock("../../backend/libraryAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend/libraryAdapter")>()),
  getLikedSongs: vi.fn(),
}));

vi.mock("../../backend/providersAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend/providersAdapter")>()),
  nativeProviderStatus: vi.fn(),
  nativeProviderLikes: vi.fn(),
}));

vi.mock("../../backend/artistAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend/artistAdapter")>()),
  getSongArtists: vi.fn(),
}));

async function hydrateNativeTrack(track: { id: string; title?: string; artist?: string }) {
  const title = track.title ?? "测试曲目";
  const artist = track.artist ?? "测试歌手";
  const queue: QueueSnapshot = {
    generation: 10,
    selectedIndex: 0,
    items: [
      {
        id: track.id,
        title,
        artist,
        album: "测试专辑",
        durationMs: 210_000,
      },
    ],
  };
  const player: NativePlayerSnapshot = {
    state: "paused",
    generation: 10,
    positionMs: 0,
    durationMs: 210_000,
    volume: 0.72,
    muted: false,
    currentTrack: { id: track.id, title, artist },
    failure: null,
  };
  await act(async () => {
    await playerActions.hydrateNative(queue, player);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invalidateProviderSession("netease");
  resetPlayerFixture();
});

describe("PlayerBar", () => {
  it("P1-01: 循环切换 4 种播放模式并区分 sequence/repeat-all 图标、展示 repeat-one 角标且无原生 title", async () => {
    const user = userEvent.setup();
    render(<PlayerBar onOpenQueue={vi.fn()} queueOpen={false} />);

    const getModeButton = () => document.querySelector<HTMLButtonElement>(".player-bar__mode")!;

    expect(getModeButton()).toHaveAttribute("aria-label", "顺序播放，点击切换模式");
    expect(getModeButton()).not.toHaveAttribute("title");
    expect(getModeButton()).not.toHaveTextContent("1");
    const sequenceSvg = getModeButton().querySelector("svg")!.outerHTML;

    await user.click(getModeButton());
    expect(getModeButton()).toHaveAttribute("aria-label", "列表循环，点击切换模式");
    expect(getModeButton()).not.toHaveAttribute("title");
    expect(getModeButton()).not.toHaveTextContent("1");
    const repeatAllSvg = getModeButton().querySelector("svg")!.outerHTML;
    expect(repeatAllSvg).not.toBe(sequenceSvg);

    await user.click(getModeButton());
    expect(getModeButton()).toHaveAttribute("aria-label", "单曲循环，点击切换模式");
    expect(getModeButton()).not.toHaveAttribute("title");
    expect(getModeButton()).toHaveTextContent("1");

    await user.click(getModeButton());
    expect(getModeButton()).toHaveAttribute("aria-label", "随机播放，点击切换模式");
    expect(getModeButton()).not.toHaveAttribute("title");
    expect(getModeButton()).not.toHaveTextContent("1");
    const shuffleSvg = getModeButton().querySelector("svg")!.outerHTML;
    expect(shuffleSvg).not.toBe(repeatAllSvg);
    expect(shuffleSvg).not.toBe(sequenceSvg);

    await user.click(getModeButton());
    expect(getModeButton()).toHaveAttribute("aria-label", "顺序播放，点击切换模式");
  });

  it("P1-02: 静音按钮位于 .player-bar__tools .player-bar__volume-group 内 #player-volume 紧左侧，不在 .player-bar__transport 内，可切换静音", async () => {
    const user = userEvent.setup();
    const { container } = render(<PlayerBar onOpenQueue={vi.fn()} queueOpen={false} />);

    const transport = container.querySelector(".player-bar__transport");
    const volumeGroup = container.querySelector(".player-bar__tools .player-bar__volume-group");
    const muteButton = screen.getByRole("button", { name: "静音" });
    const volumeInput = container.querySelector<HTMLInputElement>("#player-volume");

    expect(transport?.querySelector(".player-bar__mute")).toBeNull();
    expect(volumeGroup).not.toBeNull();
    expect(muteButton).toHaveClass("player-bar__mute");
    expect(volumeGroup!.contains(muteButton)).toBe(true);
    expect(volumeInput).not.toBeNull();
    expect(volumeGroup!.contains(volumeInput)).toBe(true);
    expect(Array.from(volumeGroup!.children)).toHaveLength(2);
    expect(volumeGroup!.children[0]!.contains(muteButton)).toBe(true);
    expect(volumeGroup!.children[1]!.contains(volumeInput)).toBe(true);
    expect(volumeInput!.value).toBe("0.72");

    await user.click(muteButton);
    expect(screen.getByRole("button", { name: "取消静音" })).toBeInTheDocument();
    expect(volumeInput!.value).toBe("0");

    await user.click(screen.getByRole("button", { name: "取消静音" }));
    expect(screen.getByRole("button", { name: "静音" })).toBeInTheDocument();
    expect(volumeInput!.value).toBe("0.72");
  });

  it("P1-04: 喜欢红心位于 .player-bar__title-row 曲名右侧，可切换状态与样式，nativeMode 未就绪禁用，本地与 B 站不显示", async () => {
    const user = userEvent.setup();
    const { container } = render(<PlayerBar onOpenQueue={vi.fn()} queueOpen={false} />);

    const titleRow = container.querySelector(".player-bar__title-row")!;
    const titleEl = titleRow.querySelector("strong")!;
    const likeButton = screen.getByRole("button", { name: "喜欢《暮色温室》" });

    expect(titleRow.contains(likeButton)).toBe(true);
    expect(titleEl.compareDocumentPosition(likeButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(likeButton).toHaveAttribute("aria-pressed", "false");
    expect(likeButton).not.toHaveClass("player-bar__liked");

    await user.click(likeButton);
    const likedButton = screen.getByRole("button", { name: "取消喜欢《暮色温室》" });
    expect(likedButton).toHaveAttribute("aria-pressed", "true");
    expect(likedButton).toHaveClass("player-bar__liked");

    await user.click(likedButton);
    expect(screen.getByRole("button", { name: "喜欢《暮色温室》" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "喜欢《暮色温室》" })).not.toHaveClass("player-bar__liked");

    // nativeMode 下 QQ 歌曲未同步 likesReady 前禁用
    await hydrateNativeTrack({ id: "001234", title: "晴天", artist: "周杰伦" });
    expect(screen.getByRole("button", { name: "喜欢《晴天》" })).toBeDisabled();

    vi.mocked(getLikedSongs).mockResolvedValue({
      generation: 1,
      page: 1,
      hasMore: false,
      total: 0,
      warningCount: 0,
      items: [],
    });
    await act(async () => {
      await playerActions.syncAccountLikes();
    });
    expect(screen.getByRole("button", { name: "喜欢《晴天》" })).toBeEnabled();

    // nativeMode 下网易歌曲未就绪 neteaseLikesReady 前禁用
    await hydrateNativeTrack({ id: "netease:track:2", title: "网易歌曲", artist: "林间频率" });
    expect(screen.getByRole("button", { name: "喜欢《网易歌曲》" })).toBeDisabled();

    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(nativeProviderStatus).mockResolvedValue({
      providerId: "netease",
      state: "ready",
      account: { providerId: "netease", id: "42", displayName: "Synthetic" },
      persistence: "saved",
      capabilities: constants.capabilities.netease as ProviderCapabilities,
    });
    vi.mocked(nativeProviderLikes).mockResolvedValue({
      accountId: "42",
      ids: ["netease:track:2"],
    });
    await act(async () => {
      await playerActions.refreshProviderLikes(true);
    });
    const neteaseLikeBtn = screen.getByRole("button", { name: "取消喜欢《网易歌曲》" });
    expect(neteaseLikeBtn).toBeEnabled();
    expect(neteaseLikeBtn).toHaveAttribute("aria-pressed", "true");

    // 本地音乐与 Bilibili 曲目不显示红心
    await hydrateNativeTrack({ id: `local_${"a".repeat(64)}_flac`, title: "本地音乐" });
    expect(container.querySelector(".player-bar__like")).toBeNull();

    await hydrateNativeTrack({ id: "bilibili:video:BV1xx411c7mD:123456", title: "B站视频" });
    expect(container.querySelector(".player-bar__like")).toBeNull();
  });

  it("P1-05: 传入 onOpenStage 时点击封面或曲名各触发一次 onOpenStage，点击歌手链接只触发艺术家导航", async () => {
    const user = userEvent.setup();
    const onOpenStage = vi.fn();
    const onOpenArtist = vi.fn();
    vi.mocked(getSongArtists).mockResolvedValue([{ id: "artist-1", name: "林间频率" }]);

    await hydrateNativeTrack({ id: "001234", title: "晴天", artist: "林间频率" });

    const { container } = render(
      <ArtistNavigationContext.Provider value={onOpenArtist}>
        <PlayerBar onOpenQueue={vi.fn()} onOpenStage={onOpenStage} queueOpen={false} />
      </ArtistNavigationContext.Provider>,
    );

    const coverButton = container.querySelector<HTMLButtonElement>(".player-bar__stage-cover")!;
    const titleButton = container.querySelector<HTMLButtonElement>(".player-bar__stage-title")!;
    const artistButton = container.querySelector<HTMLButtonElement>(".player-bar__artist .song-artist-link")!;

    expect(coverButton).not.toBeNull();
    expect(titleButton).not.toBeNull();
    expect(artistButton).not.toBeNull();

    await user.click(coverButton);
    expect(onOpenStage).toHaveBeenCalledTimes(1);

    await user.click(titleButton);
    expect(onOpenStage).toHaveBeenCalledTimes(2);

    await user.click(artistButton);
    expect(getSongArtists).toHaveBeenCalledWith("001234");
    expect(onOpenArtist).toHaveBeenCalledWith({ id: "artist-1", name: "林间频率" });
    expect(onOpenStage).toHaveBeenCalledTimes(2);
  });

  it("P1-06: .player-bar__transport 内按顺序包含 mode / prev / play / next 四个对称锚定按钮，且操作区仅渲染图标触发器", () => {
    const { container } = render(<PlayerBar onOpenQueue={vi.fn()} queueOpen={false} />);

    const transport = container.querySelector(".player-bar__transport");
    expect(transport).not.toBeNull();

    const modeButton = transport!.querySelector<HTMLButtonElement>(".player-bar__mode");
    const prevButton = transport!.querySelector<HTMLButtonElement>(".player-bar__prev");
    const playButton = transport!.querySelector<HTMLButtonElement>(".player-bar__play");
    const nextButton = transport!.querySelector<HTMLButtonElement>(".player-bar__next");

    expect(modeButton).not.toBeNull();
    expect(prevButton).not.toBeNull();
    expect(playButton).not.toBeNull();
    expect(nextButton).not.toBeNull();

    expect(prevButton).toHaveAttribute("aria-label", "上一首");
    expect(nextButton).toHaveAttribute("aria-label", "下一首");

    const buttons = Array.from(transport!.querySelectorAll("button"));
    expect(buttons).toEqual([modeButton, prevButton, playButton, nextButton]);

    const directItems = Array.from(transport!.children);
    expect(directItems).toHaveLength(4);
    expect(directItems[0]!.contains(modeButton)).toBe(true);
    expect(directItems[1]!.contains(prevButton)).toBe(true);
    expect(directItems[2]!.contains(playButton)).toBe(true);
    expect(directItems[3]!.contains(nextButton)).toBe(true);

    expect(container.querySelector(".player-bar__library .provider-library-trigger--icon")).not.toBeNull();
    expect(container.querySelector(".player-bar__library .provider-library-trigger:not(.provider-library-trigger--icon)")).toBeNull();
  });
});
