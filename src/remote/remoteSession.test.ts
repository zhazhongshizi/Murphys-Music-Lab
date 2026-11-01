import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { connectRemote, disconnectRemote, invokeRemote, remoteStatus } from "./remoteTransport";
import {
  RemoteProviderLibrary,
  describeNonReadySnapshot,
  describeRemoteProviderError,
} from "./RemoteProviderLibrary";
import { installPlaybackTransport } from "../backend/playbackTransport";
import { parseProviderSnapshot } from "../backend/providersAdapter";
import { playerActions, resetPlayerFixture, getCurrentTrack } from "../features/player/playerStore";
import constants from "../../contracts/protocol-v2.constants.json";
const item = (id: string) => ({ id, title: id, artist: "artist", album: "", durationMs: 1000 });
const state = (generation: number, id: string) => ({
  requestedQuality: "320k", mode: "sequence",
  queue: { generation, selectedIndex: 0, items: [item(id)] },
  player: { state: "paused", generation, currentTrack: { id, title: id, artist: "artist" }, positionMs: 0, durationMs: 1000, volume: .5, muted: false, failure: null },
});
afterEach(() => { cleanup(); disconnectRemote(); installPlaybackTransport(null); resetPlayerFixture(); vi.unstubAllGlobals(); });
it("accepts reset generations on a new connection", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state(40, "a"))));
  vi.stubGlobal("fetch", fetcher);
  playerActions.applyAuthoritativeSession(await connectRemote("old"));
  disconnectRemote();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "b"))));
  playerActions.applyAuthoritativeSession(await connectRemote("new"));
  expect(getCurrentTrack()?.id).toBe("b");
});
it("preserves an enqueued track when an older poll finishes", async () => {
  const initial = state(7, "a");
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(initial)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("code");
  let resolve!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const poll = invokeRemote("playback_session_snapshot");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...initial.queue, generation: 8, items: [item("a"), item("b")] })));
  await invokeRemote("queue_enqueue", { item: item("b") });
  resolve(new Response(JSON.stringify(initial)));
  expect((await poll as ReturnType<typeof state>).queue.generation).toBe(8);
  fetcher.mockResolvedValueOnce(new Response("null"));
  await expect(invokeRemote("queue_play", { index: 1 })).resolves.toBeNull();
});

it("rejects an old library body before it can overwrite a new connection", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state(7, "a"))));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("old");
  let resolve!: (value: unknown) => void;
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) });
  const old = invokeRemote("queue_enqueue", { item: item("b") });
  const rejected = expect(old).rejects.toThrow("连接已变化");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "new"))));
  await connectRemote("new");
  resolve({ ...state(8, "a").queue, items: [item("a"), item("b")] });
  await rejected;
  fetcher.mockResolvedValueOnce(new Response("null"));
  await invokeRemote("queue_play", { index: 0 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "new", queue_generation: 1 });
});

it("does not disconnect a successful newer connection when the older one finishes", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  vi.stubGlobal("fetch", fetcher);
  const old = connectRemote("old");
  const rejected = expect(old).rejects.toThrow("连接已变化");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "new"))));
  await connectRemote("new");
  resolve(new Response(JSON.stringify(state(40, "old"))));
  await rejected;
  expect(remoteStatus()).toBe("online");
});

it("gates unauthenticated, restoring, and credential_invalid Remote sources without triggering online reads", async () => {
  expect(
    describeNonReadySnapshot(
      parseProviderSnapshot({
        providerId: "netease",
        capabilities: constants.capabilities.netease,
        state: "restoring",
      }),
    ).headline,
  ).toBe("来源正在恢复会话");
  expect(
    describeNonReadySnapshot(
      parseProviderSnapshot({
        providerId: "netease",
        capabilities: constants.capabilities.netease,
        state: "disabled",
        error: "credential_invalid",
      }),
    ).detail,
  ).toContain("登录状态已失效");
  expect(describeRemoteProviderError({ code: "rate_limited" })).toContain("请求过于频繁");

  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(state(1, "a"))))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          providerId: "netease",
          capabilities: constants.capabilities.netease,
          state: "disabled",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("code");

  render(
    createElement(RemoteProviderLibrary, {
      providerId: "netease",
      onBack: () => {},
      onSelectSource: () => {},
    }),
  );

  await screen.findByText("请在桌面端登录");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.some(
      ([, init]) =>
        typeof init?.body === "string" && JSON.parse(init.body).command === "provider_read",
    ),
  ).toBe(false);
});

it("expands Bilibili video parts on Remote and enqueues playable cid items into the mixed queue", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(state(1, "a"))))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          providerId: "bilibili",
          capabilities: constants.capabilities.bilibili,
          state: "ready",
          account: { providerId: "bilibili", id: "42", displayName: "B站测试" },
          persistence: "saved",
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          page: 1,
          hasMore: false,
          total: 1,
          items: [
            {
              providerId: "bilibili",
              id: "bilibili:favorite:7",
              kind: "favoriteFolder",
              ownership: "created",
              owner: { providerId: "bilibili", id: "42" },
              title: "默认收藏夹",
              description: "",
              itemCount: 1,
              allowedActions: [],
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          providerId: "bilibili",
          id: "bilibili:favorite:7",
          kind: "favoriteFolder",
          ownership: "created",
          owner: { providerId: "bilibili", id: "42" },
          title: "默认收藏夹",
          description: "",
          itemCount: 1,
          allowedActions: [],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          page: 1,
          hasMore: false,
          total: 1,
          items: [
            {
              providerId: "bilibili",
              bvid: "BV17x411w7KC",
              aid: "170001",
              title: "视频原题",
              uploader: "UP 主",
              durationMs: 215_000,
              availability: "unknown",
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          page: 1,
          hasMore: false,
          total: 2,
          items: [
            {
              providerId: "bilibili",
              id: "bilibili:video:BV17x411w7KC:123",
              title: "视频原题 / 第一 P 原题",
              artist: "UP 主",
              creatorKind: "uploader",
              album: "",
              durationMs: 120_000,
              availability: "unknown",
              video: { title: "视频原题", partTitle: "第一 P 原题", partNumber: 1 },
            },
            {
              providerId: "bilibili",
              id: "bilibili:video:BV17x411w7KC:124",
              title: "视频原题 / 第二 P 原题",
              artist: "UP 主",
              creatorKind: "uploader",
              album: "",
              durationMs: 95_000,
              availability: "unknown",
              video: { title: "视频原题", partTitle: "第二 P 原题", partNumber: 2 },
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          generation: 2,
          selectedIndex: 0,
          items: [
            item("a"),
            {
              providerId: "bilibili",
              id: "bilibili:video:BV17x411w7KC:124",
              title: "视频原题 / 第二 P 原题",
              artist: "UP 主",
              album: "",
              durationMs: 95_000,
              video: { title: "视频原题", partTitle: "第二 P 原题", partNumber: 2 },
            },
          ],
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("code");

  render(
    createElement(RemoteProviderLibrary, {
      providerId: "bilibili",
      onBack: () => {},
      onSelectSource: () => {},
    }),
  );

  fireEvent.click(await screen.findByRole("button", { name: "查看视频" }));
  fireEvent.click(await screen.findByRole("button", { name: "展开分 P" }));
  await screen.findByText("P2 · 第二 P 原题");
  const addButtons = await screen.findAllByRole("button", { name: "加队列" });
  fireEvent.click(addButtons[1]!);

  await waitFor(() =>
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
      command: "queue_enqueue",
      providerId: "bilibili",
      id: "bilibili:video:BV17x411w7KC:124",
    }),
  );
});
