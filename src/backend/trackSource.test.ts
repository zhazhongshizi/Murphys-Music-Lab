import { describe, it, expect } from "vitest";
import { parseQueueTrack } from "./nativeQueueAdapter";
import { providerErrorMessages } from "../contracts/providerErrors";
describe("3a source boundary", () => {
  const track = { id: "netease:track:123", title: "Synthetic", artist: "Fixture", album: "", durationMs: 1000 };
  it("preserves explicit sources and rejects mismatched sources", () => {
    expect(parseQueueTrack({ ...track, providerId: "netease" }).providerId).toBe("netease");
    expect(() => parseQueueTrack({ ...track, providerId: "qqmusic" })).toThrow();
    expect(() => parseQueueTrack({ ...track, providerId: "unknown" })).toThrow();
    expect(() => parseQueueTrack(track)).toThrow();
    expect(() => parseQueueTrack({ ...track, providerId: "netease", credential: "SYNTHETIC_TEST_ONLY" })).toThrow();
  });
  it("keeps risk verification distinct from write readback failure", () => {
    expect(providerErrorMessages.verification_required).toContain("安全验证");
    expect(providerErrorMessages.verification_failed).toContain("写入结果");
  });
});
