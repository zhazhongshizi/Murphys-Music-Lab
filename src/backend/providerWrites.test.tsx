import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeProviderWrite, parseProviderWriteRequest, parseProviderWriteReceipt } from "./providersAdapter";
import { installPlaybackTransport } from "./playbackTransport";
import { invalidateProviderSession } from "./providerSessions";
import constants from "../../contracts/protocol-v2.constants.json";
import type { ProviderWriteRequest } from "../contracts/providers";
import { ProviderLibraryActions } from "../features/library/ProviderLibraryActions";
import { playerActions, resetPlayerFixture, usePlayerSnapshot } from "../features/player/playerStore";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), qqLikes: vi.fn(), qqWrite: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("./libraryAdapter", async original => ({ ...await original<typeof import("./libraryAdapter")>(), getLikedSongs: mock.qqLikes, setSongsLiked: mock.qqWrite }));
const request: ProviderWriteRequest = { providerId: "netease", accountId: "42", operation: { kind: "setLiked", trackId: "netease:track:2", liked: true } };
const applied = { status: "applied", affectedCount: null };
const pending = { status: "verificationPending", affectedCount: null };
let write: Promise<unknown> | null;
let ids: string[];
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  resetPlayerFixture(); vi.resetAllMocks(); write = null; ids = ["netease:track:1"];
  invalidateProviderSession("netease"); invalidateProviderSession("bilibili");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  mock.qqLikes.mockResolvedValue({ items: [{ id: "qqA" }], hasMore: false });
  mock.qqWrite.mockResolvedValue({ status: "applied" });
  mock.invoke.mockImplementation(async (command, payload) => {
    const p = payload?.providerId ?? "netease";
    if (command === "provider_status") return { providerId: p, state: "ready", capabilities: constants.capabilities[p as "netease" | "bilibili"], account: { providerId: p, id: "42", displayName: "Synthetic" }, persistence: "saved" };
    if (command === "provider_likes") return { accountId: "42", ids };
    if (command === "provider_write") return write ?? applied;
    if (command === "provider_verify_write") return applied;
    if (command === "provider_read") {
      const container = { providerId: p, id: p === "netease" ? "netease:playlist:7" : "bilibili:favorite:7", kind: p === "netease" ? "playlist" : "favoriteFolder", ownership: "created", owner: { providerId: p, id: "42" }, title: "目标容器", description: "", itemCount: 1, allowedActions: p === "netease" ? ["playlist.addTracks", "playlist.removeTracks"] : ["favorite.addVideos", "favorite.removeVideos"] };
      return payload.method === "library.container" ? container : { page: 1, total: 1, hasMore: false, items: [{ ...container, allowedActions: [] }] };
    }
    throw new Error("unexpected mock command");
  });
});
afterEach(() => { cleanup(); installPlaybackTransport(null); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); resetPlayerFixture(); });
it("strict public write identity and receipt boundaries reject extra fields and mixed sources before invoke", async () => {
  for (const bad of [ { ...request, generation: 1 }, { ...request, providerId: "qqmusic" }, { ...request, providerId: "bilibili" }, { ...request, operation: { ...request.operation, ownerId: "42" } }, { ...request, operation: { kind: "addItems", containerId: "netease:playlist:7", trackIds: ["songA"] } }, { ...request, operation: { kind: "addItems", containerId: "bilibili:favorite:7", trackIds: ["netease:track:2"] } } ]) expect(() => parseProviderWriteRequest(bad)).toThrow();
  for (const bad of [{ ...applied, cookie: "secret" }, { status: "verificationPending", affectedCount: 1 }, { status: "applied", affectedCount: 101 }]) expect(() => parseProviderWriteReceipt(bad)).toThrow();
  expect(mock.invoke).not.toHaveBeenCalled();
});
it("two entrypoints cannot concurrently submit the same target, including opposite goals", async () => {
  const d = deferred<unknown>(); write = d.promise;
  const first = nativeProviderWrite(request);
  await expect(nativeProviderWrite({ ...request, operation: { ...request.operation, liked: false } } as ProviderWriteRequest)).rejects.toThrow();
  d.resolve(applied); await first; expect(mock.invoke.mock.calls.filter(([c]) => c === "provider_write")).toHaveLength(1);
});
it("Remote shared state cannot invoke any new desktop write, even with a desktop marker", async () => {
  installPlaybackTransport(vi.fn()); await expect(nativeProviderWrite(request)).rejects.toThrow(); expect(mock.invoke).not.toHaveBeenCalled();
});
for (const variant of ["default", "rhine"] as const) it(`${variant} keeps captured target on track/page changes and verifies pending through read-only command`, async () => {
  write = Promise.resolve(pending);
  const view = render(<ProviderLibraryActions variant={variant} track={{ id: "netease:track:2", title: "原歌曲" }} />);
  fireEvent.click(screen.getByRole("button", { name: "网易喜欢 / 歌单操作" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "喜欢此歌曲" })).toBeEnabled());
  view.rerender(<ProviderLibraryActions variant={variant} track={{ id: "bilibili:video:BV17x411w7KC:123", title: "新视频" }} />);
  fireEvent.click(screen.getByRole("button", { name: "喜欢此歌曲" }));
  await screen.findByText(/结果待核对：原歌曲/);
  expect(mock.invoke).toHaveBeenCalledWith("provider_write", { request });
  fireEvent.click(screen.getByRole("button", { name: "只读核对结果" }));
  await screen.findByText(/已核实目标状态：原歌曲/);
  expect(mock.invoke).toHaveBeenCalledWith("provider_verify_write", { request });
  expect(mock.invoke.mock.calls.filter(([c]) => c === "provider_write")).toHaveLength(1);
});
it("Bilibili labels video favorite explicitly and routes remove to the chosen existing folder", async () => {
  render(<ProviderLibraryActions track={{ id: "bilibili:video:BV17x411w7KC:124", title: "视频 P2" }} />);
  fireEvent.click(screen.getByRole("button", { name: "添加到收藏夹 / 移出" }));
  await screen.findByText(/视频本体/);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: /目标容器/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认移出" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "确认移出" }));
  await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("provider_write", { request: { providerId: "bilibili", accountId: "42", operation: { kind: "removeItems", containerId: "bilibili:favorite:7", trackIds: ["bilibili:video:BV17x411w7KC:124"] } } }));
  expect(screen.queryByRole("button", { name: "喜欢此歌曲" })).not.toBeInTheDocument();
});
it("QQ and NetEase likes merge, single-source clearing preserves the other, confirmed deltas route by identity", async () => {
  const probe = renderHook(usePlayerSnapshot);
  await act(async () => { await playerActions.syncAccountLikes(); await playerActions.refreshProviderLikes(true); });
  expect(probe.result.current.likedIds).toEqual(expect.arrayContaining(["qqA", "netease:track:1"]));
  await act(async () => { expect(await playerActions.setSongLiked("netease:track:2", true)).toBe(true); });
  expect(mock.qqWrite).not.toHaveBeenCalled(); expect(probe.result.current.likedIds).toContain("netease:track:2");
  act(() => playerActions.clearAccountLikes()); expect(probe.result.current.likedIds).toEqual(expect.arrayContaining(["netease:track:1", "netease:track:2"]));
  await act(async () => { await playerActions.syncAccountLikes(); });
  act(() => playerActions.invalidateProviderLikes()); expect(probe.result.current.likedIds).toEqual(["qqA"]);
});
it("pending and late write responses never update likes or a replacement account", async () => {
  const probe = renderHook(usePlayerSnapshot);
  await act(async () => { await playerActions.refreshProviderLikes(true); });
  write = Promise.resolve(pending);
  await act(async () => { expect(await playerActions.setSongLiked("netease:track:2", true)).toBe(false); });
  expect(probe.result.current.likedIds).not.toContain("netease:track:2");
  await expect(nativeProviderWrite(request)).rejects.toThrow();
  await nativeProviderWrite(request, true);
  const d = deferred<unknown>(); write = d.promise;
  let operation!: Promise<boolean>;
  await act(async () => { operation = playerActions.setSongLiked("netease:track:2", true); await Promise.resolve(); });
  invalidateProviderSession("netease");
  await act(async () => { playerActions.invalidateProviderLikes(); d.resolve(applied); expect(await operation).toBe(false); });
  expect(probe.result.current.likedIds).not.toContain("netease:track:2");
});
it("older full likes read cannot overwrite a newer confirmed write", async () => {
  const probe = renderHook(usePlayerSnapshot);
  const d = deferred<unknown>();
  const base = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation((c, p) => c === "provider_likes" ? d.promise : base(c, p));
  let read!: Promise<void>;
  await act(async () => { read = playerActions.refreshProviderLikes(true); await Promise.resolve(); });
  await act(async () => { await playerActions.setSongLiked("netease:track:2", true); });
  await act(async () => { d.resolve({ accountId: "42", ids: ["netease:track:1"] }); await read; });
  expect(probe.result.current.likedIds).toContain("netease:track:2");
});
