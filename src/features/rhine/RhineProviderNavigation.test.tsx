import { useContext, useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../backend/providersAdapter";
import constants from "../../../contracts/protocol-v2.constants.json";
import type { ProviderCapabilities, ProviderContainer } from "../../contracts/providers";
import { DesktopProviders } from "../providers/DesktopProviders";
import { ArchivePageTransitionContext } from "./ArchivePageTransition";
import RhineMode from "./RhineMode";

vi.mock("../../backend/providersAdapter", async original => ({
  ...await original<typeof import("../../backend/providersAdapter")>(),
  nativeProviderStatus: vi.fn(), nativeProviderLibraryContainers: vi.fn(),
  nativeProviderContainer: vi.fn(), nativeProviderLibraryVideos: vi.fn(),
}));
vi.mock("./RhineBoot", () => ({ RhineBoot: ({onComplete}: {onComplete: () => void}) => {
  useEffect(onComplete, []); return null;
} }));
vi.mock("./ArchiveCanvas", () => ({ ArchiveCanvas: () => {
  const transition = useContext(ArchivePageTransitionContext);
  useEffect(() => { if (transition?.phase === "entering") transition.onEntered(); }, [transition]);
  return <div data-testid="archive-scene" />;
} }));
const collected: ProviderContainer = { providerId: "bilibili", id: "bilibili:favorite:8", kind: "favoriteFolder", ownership: "collected", owner: {providerId:"bilibili", id:"99"}, title: "他人的收藏夹", description: "", itemCount: 2, allowedActions: [] };
const own: ProviderContainer = {...collected, id:"bilibili:favorite:7", ownership:"created", owner:{providerId:"bilibili",id:"42"}, title:"自己的收藏夹"};
const props = {auth:{state:"signedOut" as const}, authRecovering:false, active:true, onExit:()=>{}, onAccount:()=>{}};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); localStorage.setItem("qqmusic_browse_source_v1", "bilibili");
  Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
  vi.mocked(api.nativeProviderStatus).mockImplementation(async providerId => {
    if (providerId === "qqmusic") throw new Error("Unexpected QQ status request");
    return {providerId, state:"ready", account:{providerId,id:"42",displayName:"合成账号"}, persistence:"saved", capabilities:constants.capabilities[providerId] as ProviderCapabilities};
  });
  vi.mocked(api.nativeProviderLibraryContainers).mockImplementation(async (_id,kind,page=1) => ({page,hasMore:kind==="favorite"&&page===1,total:2,items:[kind==="favorite"?collected:own]}));
  vi.mocked(api.nativeProviderContainer).mockResolvedValue(collected);
  vi.mocked(api.nativeProviderLibraryVideos).mockResolvedValue({page:1,hasMore:false,total:0,items:[]});
});
afterEach(() => {cleanup(); Reflect.deleteProperty(window,"__TAURI_INTERNALS__");});
async function start() {
  render(<DesktopProviders><RhineMode {...props} /></DesktopProviders>);
  await screen.findByRole("heading", {name:own.title});
  fireEvent.click(screen.getByRole("button", {name:"收藏的他人收藏夹"}));
}
it("the top favorite entry reads collected folders and resets detail and pagination when selected again", async () => {
  await start();
  await screen.findByRole("heading", {name:collected.title});
  expect(api.nativeProviderLibraryContainers).toHaveBeenLastCalledWith("bilibili","favorite",1,50);
  expect(screen.getByRole("button", {name:"收藏的他人收藏夹"})).toHaveAttribute("aria-pressed","true");
  expect(document.querySelector(".rhine-provider-bar")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"打开此容器"}));
  await screen.findByRole("button", {name:"返回容器列表"});
  fireEvent.click(screen.getByRole("button", {name:"收藏的他人收藏夹"}));
  await screen.findByRole("button", {name:"打开此容器"});
  expect(screen.queryByRole("button", {name:"返回容器列表"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name:"下一页"}));
  await waitFor(() => expect(api.nativeProviderLibraryContainers).toHaveBeenLastCalledWith("bilibili","favorite",2,50));
  fireEvent.click(screen.getByRole("button", {name:"收藏的他人收藏夹"}));
  await waitFor(() => expect(api.nativeProviderLibraryContainers).toHaveBeenLastCalledWith("bilibili","favorite",1,50));
});
it("an empty collected page is identified without falling back to own folders", async () => {
  vi.mocked(api.nativeProviderLibraryContainers).mockImplementation(async (_id,kind) => ({page:1,hasMore:false,total:0,items:kind==="created"?[own]:[]}));
  await start();
  await screen.findByText("本页没有收藏的他人收藏夹");
  expect(screen.queryByRole("heading", {name:own.title})).not.toBeInTheDocument();
  expect(api.nativeProviderLibraryContainers).toHaveBeenLastCalledWith("bilibili","favorite",1,50);
});
