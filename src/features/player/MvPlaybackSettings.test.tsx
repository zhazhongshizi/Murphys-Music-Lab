import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MvFallbackSetting, MvLyricOffsetControl } from "./MvPlaybackSettings";
import { playerActions } from "./playerStore";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  state: {
    track: { id: "mv-1", title: "MV 曲目", artist: "歌手", album: "专辑", accent: "#789575", durationMs: 180000, actualQuality: "QQ MV 音轨", lyrics: [] } as { id: string; title: string; artist: string; album: string; accent: string; durationMs: number; actualQuality: string; lyrics: never[] } | null,
    lyricOffsetMs: 0,
    nativeMode: true,
  },
  setMvLyricOffset: vi.fn(),
}));

vi.mock("../../backend/settingsAdapter", () => ({ nativeSettingsSnapshot: mocks.read, nativeSetMvFallbackEnabled: mocks.save }));
vi.mock("./playerStore", () => ({
  getCurrentTrack: (s: typeof mocks.state) => s.track,
  usePlayerSelector: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
  playerActions: {
    setMvLyricOffset: mocks.setMvLyricOffset,
  },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.state.track = { id: "mv-1", title: "MV 曲目", artist: "歌手", album: "专辑", accent: "#789575", durationMs: 180000, actualQuality: "QQ MV 音轨", lyrics: [] };
  mocks.state.lyricOffsetMs = 0;
  mocks.state.nativeMode = true;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("MvFallbackSetting", () => {
  it("uses the saved MV preference and only updates after persistence succeeds", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    mocks.read.mockResolvedValue({ mvFallbackEnabled: false });
    mocks.save.mockResolvedValue({ mvFallbackEnabled: true });
    render(<MvFallbackSetting />);
    const toggle = screen.getByRole("switch", { name: "原曲不可用时使用 QQ MV 音轨" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mocks.save).toHaveBeenCalledWith(true);
  });

  it("does not display an unsaved MV preference as successfully enabled", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    mocks.read.mockResolvedValue({ mvFallbackEnabled: false });
    mocks.save.mockRejectedValue(new Error("disk write failed"));
    render(<MvFallbackSetting />);
    const toggle = screen.getByRole("switch", { name: "原曲不可用时使用 QQ MV 音轨" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await screen.findByRole("alert");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

describe("MvLyricOffsetControl", () => {
  it("renders nothing outside native mode or non-MV tracks", () => {
    mocks.state.nativeMode = false;
    const { rerender } = render(<MvLyricOffsetControl />);
    expect(screen.queryByLabelText("MV 歌词同步")).not.toBeInTheDocument();

    mocks.state.nativeMode = true;
    mocks.state.track = { ...mocks.state.track!, actualQuality: "FLAC" };
    rerender(<MvLyricOffsetControl />);
    expect(screen.queryByLabelText("MV 歌词同步")).not.toBeInTheDocument();
  });

  it("renders compact stepper with zero offset and disabled reset button", () => {
    render(<MvLyricOffsetControl />);
    expect(screen.getByText("无偏移")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MV 歌词提前 0.5 秒" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "MV 歌词延后 0.5 秒" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重置 MV 歌词偏移" })).toBeDisabled();
  });

  it("steps -0.5s, +0.5s, formats signed seconds, and resets to 0", async () => {
    mocks.setMvLyricOffset.mockResolvedValue(undefined);
    const { rerender } = render(<MvLyricOffsetControl />);

    fireEvent.click(screen.getByRole("button", { name: "MV 歌词提前 0.5 秒" }));
    await waitFor(() => expect(mocks.setMvLyricOffset).toHaveBeenCalledWith(-500));

    mocks.state.lyricOffsetMs = -500;
    rerender(<MvLyricOffsetControl />);
    expect(screen.getByText("-0.5s")).toBeInTheDocument();

    const resetBtn = screen.getByRole("button", { name: "重置 MV 歌词偏移" });
    expect(resetBtn).toBeEnabled();
    fireEvent.click(resetBtn);
    await waitFor(() => expect(playerActions.setMvLyricOffset).toHaveBeenCalledWith(0));

    mocks.state.lyricOffsetMs = 1500;
    rerender(<MvLyricOffsetControl />);
    expect(screen.getByText("+1.5s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MV 歌词延后 0.5 秒" }));
    await waitFor(() => expect(mocks.setMvLyricOffset).toHaveBeenCalledWith(2000));
  });

  it("enforces ±60s bounds and surfaces save failure alert", async () => {
    mocks.state.lyricOffsetMs = -60000;
    const { rerender } = render(<MvLyricOffsetControl />);
    expect(screen.getByRole("button", { name: "MV 歌词提前 0.5 秒" })).toBeDisabled();

    mocks.state.lyricOffsetMs = 60000;
    rerender(<MvLyricOffsetControl />);
    expect(screen.getByRole("button", { name: "MV 歌词延后 0.5 秒" })).toBeDisabled();

    mocks.setMvLyricOffset.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(screen.getByRole("button", { name: "MV 歌词提前 0.5 秒" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("歌词偏移保存失败，请重试");
  });
});
