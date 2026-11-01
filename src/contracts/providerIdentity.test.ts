import { describe, expect, it } from "vitest";
import vectors from "../../tests/fixtures/provider-v2/identities.json";
import constants from "../../contracts/protocol-v2.constants.json";
import type { Method, Request, Response } from "../../contracts/provider-v2";
import type { ProviderCapabilities, ProviderId } from "./providers";
import { bilibiliTrackId, containerProvider, decodeTrackRef, neteaseTrackId, trackProvider } from "./providerIdentity";

describe("multi-provider canonical identity", () => {
  it.each(vectors.tracks)("routes $id", ({ id, providerId }) => {
    expect(trackProvider(id)).toBe(providerId);
    expect(decodeTrackRef(id)).toEqual(providerId ? { id, providerId } : null);
    if (providerId) {
      expect(decodeTrackRef(id, providerId as ProviderId)).toEqual({ id, providerId });
      expect(decodeTrackRef(id, providerId === "qqmusic" ? "bilibili" : "qqmusic")).toBeNull();
    }
  });
  it.each(vectors.containers)("routes container $id", ({ id, providerId }) => {
    expect(containerProvider(id)).toBe(providerId);
    if (providerId) expect(decodeTrackRef(id)).toBeNull();
  });
  it("does not collide across platforms, parts, or round large numeric IDs", () => {
    const ids = ["123", neteaseTrackId("123"), bilibiliTrackId("BV17x411w7KC", "123"), bilibiliTrackId("BV17x411w7KC", "124")];
    expect(new Set(ids).size).toBe(4);
    expect(neteaseTrackId("9007199254740993")).toBe("netease:track:9007199254740993");
    for (const id of ["0", "01", "-1", "1\n", "1e2", "１２"]) expect(() => neteaseTrackId(id)).toThrow("invalid_track_identity");
    expect(() => bilibiliTrackId("bv17x411w7KC", "1")).toThrow();
  });
  it("keeps private method maps type aligned and public capabilities usable", () => {
    // Checked by tsc: schema catalogue additions must also update the private type map.
    const names: Method[] = Object.keys(constants.methods) as (keyof typeof constants.methods)[];
    expect(new Set(names).size).toBe(28);
    expect(names).toEqual(expect.arrayContaining(["library.container", "library.likes", "library.verify"]));
    const request: Request = { v: 2, id: "fixture", method: "playback.resolve", params: { track: { kind: "song", songId: "123" }, preferredQuality: "auto" } };
    const response: Response<"library.addItems"> = { v: 2, id: request.id, ok: true, result: { status: "verificationPending", affectedCount: null }, warnings: [] };
    expect(response.result.status).toBe("verificationPending");
    const capabilities: ProviderCapabilities = { loginMethods: ["qr"], searchKinds: ["videos"], libraryKinds: ["created", "favorite"], writeActions: ["favorite.addVideos", "favorite.removeVideos"], lyrics: false, qualities: ["auto", "aac"] };
    expect(capabilities).toEqual(constants.capabilities.bilibili);
  });
});
