import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import biliPlayer from "../../../tests/fixtures/provider-v2/bilibili-player-snapshot.json";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { parsePlaybackLoadResult, parsePlayerSnapshot } from "../../backend/nativePlayerAdapter";
import { parseQueuePlayResult } from "../../backend/nativeQueueAdapter";
import { getCurrentTrack, playerActions, usePlayerSelector } from "./playerStore";
import { NativePlayerBridge } from "./NativePlayerBridge";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const qq = { id: "qqmid", providerId: "qqmusic", title: "QQ previous track", artist: "QQ artist", album: "QQ album", durationMs: 290000 };
const bili = { ...biliPlayer.currentTrack, album: "Video", durationMs: 240000,
  coverCacheKey: "bili_BV17x411w7KC", video: { title: "Video", partTitle: biliPlayer.currentTrack.title, partNumber: 1 } };
const queue = { generation: 1, selectedIndex: 0, items: [qq, bili] };
const session = { mode: "shuffle", requestedQuality: "128k", actualQuality: "128k", queue,
  player: { ...biliPlayer, generation: 7, currentTrack: { id: qq.id, providerId: qq.providerId, title: qq.title, artist: qq.artist } } };
const switched = { ...session, actualQuality: "aac", actualBitrate: 192000,
  queue: { ...queue, generation: 2, selectedIndex: 1 }, player: biliPlayer };

function PlaybackView() {
  const track = usePlayerSelector(getCurrentTrack);
  const position = usePlayerSelector(s => s.positionMs);
  return <output data-testid="playback">{track?.title}|{track?.actualQuality}|{track?.coverCacheKey}|{position}</output>;
}

beforeEach(() => {
  invoke.mockReset();
  beginPlaybackSession();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("polls QQ to Bilibili through the real adapters and updates title, cover, quality and progress", async () => {
  let current: unknown = session;
  invoke.mockImplementation(async (command: string) => {
    if (command === "playback_session_snapshot") return current;
    throw new Error("unavailable fixture capability");
  });
  render(<><NativePlayerBridge /><PlaybackView /></>);
  await waitFor(() => expect(screen.getByTestId("playback")).toHaveTextContent(qq.title));
  current = switched;
  await waitFor(() => expect(screen.getByTestId("playback")).toHaveTextContent(
    `${bili.title}|AAC 192 kbps|${bili.coverCacheKey}|1200`), { timeout: 2000 });
  current = { ...switched, queue: null, player: { ...biliPlayer, positionMs: 2200 } };
  await waitFor(() => expect(screen.getByTestId("playback")).toHaveTextContent("|2200"), { timeout: 2000 });
});

it("accepts the shared Rust playback result on explicit switching and rejects the old malformed summary", async () => {
  const load = { quality: "aac", bitrate: 192000, expiresInSeconds: 0, player: biliPlayer };
  const result = parseQueuePlayResult({ requestedQuality: "128k", queue: switched.queue, playback: load });
  expect(parsePlaybackLoadResult(load).player.currentTrack?.id).toBe(bili.id);
  await playerActions.hydrateNative(result.queue, result.playback.player, result.playback.quality, result.playback.bitrate);
  render(<PlaybackView />);
  expect(screen.getByTestId("playback")).toHaveTextContent(`${bili.title}|AAC 192 kbps|${bili.coverCacheKey}`);
  expect(() => parsePlayerSnapshot({ ...biliPlayer, currentTrack: { ...biliPlayer.currentTrack, coverCacheKey: bili.coverCacheKey } })).toThrow();
});
