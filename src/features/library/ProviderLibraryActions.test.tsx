import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeProviderContainer, nativeProviderLibraryContainers, nativeProviderStatus, nativeProviderWrite } from "../../backend/providersAdapter";
import { invalidateProviderSession } from "../../backend/providerSessions";
import constants from "../../../contracts/protocol-v2.constants.json";
import type { ProviderCapabilities, ProviderContainer } from "../../contracts/providers";
import { ProviderLibraryActions } from "./ProviderLibraryActions";

vi.mock("../../backend/providersAdapter", async original => ({
  ...await original<typeof import("../../backend/providersAdapter")>(),
  nativeProviderContainer: vi.fn(), nativeProviderLibraryContainers: vi.fn(), nativeProviderStatus: vi.fn(), nativeProviderWrite: vi.fn(),
}));
vi.mock("../player/playerStore", () => ({ playerActions: { applyVerifiedProviderLike: vi.fn(), refreshProviderLikes: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const container = (id: string): ProviderContainer => ({
  providerId: "netease", id: `netease:playlist:${id}`, kind: "playlist", ownership: "collected",
  owner: { providerId: "netease", id: "99" }, title: "同名歌单", description: "", itemCount: 0,
  allowedActions: ["playlist.subscribe", "playlist.unsubscribe"],
});
beforeEach(() => {
  vi.resetAllMocks(); invalidateProviderSession("netease");
  vi.mocked(nativeProviderStatus).mockResolvedValue({ providerId: "netease", state: "ready", account: { providerId: "netease", id: "42", displayName: "Synthetic" }, persistence: "saved", capabilities: constants.capabilities.netease as ProviderCapabilities });
  vi.mocked(nativeProviderLibraryContainers).mockResolvedValue({ page: 1, hasMore: false, total: 0, items: [] });
  vi.mocked(nativeProviderWrite).mockResolvedValue({ status: "applied", affectedCount: null });
});
afterEach(cleanup);
async function open(variant: "default" | "rhine") {
  const view = render(<ProviderLibraryActions variant={variant} track={{ id: "netease:track:2", title: "原歌曲" }} />);
  fireEvent.click(screen.getByRole("button", { name: "网易喜欢 / 歌单操作" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "读取目标歌单" })).toBeEnabled());
  return view;
}
function read(id: string) {
  fireEvent.change(screen.getByLabelText("歌单 ID"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "读取目标歌单" }));
}
function expectNoConfirmation() {
  for (const name of ["确认收藏歌单", "确认取消收藏歌单"]) {
    const button = screen.queryByRole("button", { name });
    if (button) expect(button).toBeDisabled();
  }
  expect(nativeProviderWrite).not.toHaveBeenCalled();
}

describe.each(["default", "rhine"] as const)("%s subscription read identity", variant => {
  it.each([true, false])("older success cannot redirect a newer target, subscribed=%s", async subscribed => {
    const old = deferred<ProviderContainer>(), current = deferred<ProviderContainer>();
    vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await open(variant); read("7"); read("8");
    await act(async () => { current.resolve(container("8")); });
    await act(async () => { old.resolve(container("7")); });
    expect(screen.getByLabelText("歌单 ID")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: subscribed ? "确认收藏歌单" : "确认取消收藏歌单" }));
    await waitFor(() => expect(nativeProviderWrite).toHaveBeenCalledExactlyOnceWith({ providerId: "netease", accountId: "42", operation: { kind: "setSubscribed", containerId: "netease:playlist:8", subscribed } }, false));
    expect(screen.getAllByText(/同名歌单.*netease:playlist:8/).length).toBeGreaterThan(0);
  });
  it("older failure cannot erase a newer successful target or its notice", async () => {
    const old = deferred<ProviderContainer>(), current = deferred<ProviderContainer>();
    vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await open(variant); read("7"); read("8");
    await act(async () => { current.resolve(container("8")); });
    const notice = screen.getByRole("status").textContent;
    await act(async () => { old.reject(new Error("old failure")); });
    expect(screen.getByRole("status")).toHaveTextContent(notice!);
    expect(screen.getByRole("button", { name: "确认收藏歌单" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认收藏歌单" }));
    await waitFor(() => expect(nativeProviderWrite).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: "setSubscribed", containerId: "netease:playlist:8", subscribed: true } }), false));
  });
  it.each(["success", "failure"] as const)("input change without another read invalidates pending %s", async outcome => {
    const old = deferred<ProviderContainer>(); vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise);
    await open(variant); read("7");
    fireEvent.change(screen.getByLabelText("歌单 ID"), { target: { value: "8" } });
    const notice = screen.getByRole("status").textContent;
    await act(async () => { if (outcome === "success") old.resolve(container("7")); else old.reject(new Error("old failure")); });
    expectNoConfirmation(); expect(screen.getByRole("status")).toHaveTextContent(notice!);
  });
  it("editing a verified input disables confirmation until that input is read", async () => {
    vi.mocked(nativeProviderContainer).mockResolvedValueOnce(container("7"));
    await open(variant); read("7");
    await waitFor(() => expect(screen.getByRole("button", { name: "确认收藏歌单" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("歌单 ID"), { target: { value: "8" } });
    expectNoConfirmation(); expect(nativeProviderContainer).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "failure"] as const)("a newer read of the same input invalidates old %s", async outcome => {
    const old = deferred<ProviderContainer>(), current = deferred<ProviderContainer>();
    vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await open(variant); read("7");
    fireEvent.click(screen.getByRole("button", { name: "读取目标歌单" }));
    await act(async () => { if (outcome === "success") old.resolve(container("7")); else old.reject(new Error("old failure")); });
    expectNoConfirmation();
    await act(async () => { current.resolve(container("7")); });
    expect(screen.getByRole("button", { name: "确认收藏歌单" })).toBeEnabled();
  });
  it.each(["success", "failure"] as const)("closing and reopening discards old %s", async outcome => {
    const old = deferred<ProviderContainer>(); vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise);
    await open(variant); read("7");
    fireEvent.click(screen.getByRole("button", { name: "关闭云端操作" }));
    fireEvent.click(screen.getByRole("button", { name: "网易喜欢 / 歌单操作" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "读取目标歌单" })).toBeEnabled());
    const notice = screen.getByRole("status").textContent;
    await act(async () => { if (outcome === "success") old.resolve(container("7")); else old.reject(new Error("old failure")); });
    expectNoConfirmation(); expect(screen.getByLabelText("歌单 ID")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(notice!);
  });
  it.each(["success", "failure"] as const)("account revision invalidates pending %s, including same-account re-login", async outcome => {
    const old = deferred<ProviderContainer>(); vi.mocked(nativeProviderContainer).mockReturnValueOnce(old.promise);
    await open(variant); read("7");
    act(() => invalidateProviderSession("netease"));
    const notice = screen.getByRole("status").textContent;
    await act(async () => { if (outcome === "success") old.resolve(container("7")); else old.reject(new Error("old failure")); });
    expectNoConfirmation(); expect(screen.getByRole("status")).toHaveTextContent(notice!);
  });
  it("does not trust a returned container for a different canonical ID", async () => {
    vi.mocked(nativeProviderContainer).mockResolvedValueOnce(container("7"));
    await open(variant); read("8");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("歌单读取失败"));
    expectNoConfirmation();
  });
});
