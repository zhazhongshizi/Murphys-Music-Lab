import { useEffect, useRef, useState } from "react";
import { nativeProviderContainer, nativeProviderLibraryContainers, nativeProviderStatus, nativeProviderWrite, ProviderAdapterError } from "../../backend/providersAdapter";
import { isRemotePlayback } from "../../backend/playbackTransport";
import { providerSessionRevision, subscribeProviderSessions } from "../../backend/providerSessions";
import type { NewProviderId, ProviderContainer, ProviderWriteAction, ProviderWriteOperation, ProviderWriteRequest } from "../../contracts/providers";
import { trackProvider } from "../../contracts/providerIdentity";
import { playerActions } from "../player/playerStore";
import PlaylistPicker from "./PlaylistPicker";
import "./providerLibraryActions.css";

type Track = { id: string; title: string };
type SubscriptionTarget = { container: ProviderContainer; input: string; request: number; revision: number };
function Form({ track, providerId, variant, initialContainer }: { track: Track; providerId: NewProviderId; variant: "default" | "rhine"; initialContainer?: ProviderContainer }) {
  const [account, setAccount] = useState("");
  const [containers, setContainers] = useState<ProviderContainer[]>([]);
  const [target, setTarget] = useState(initialContainer?.id ?? "");
  const [capabilities, setCapabilities] = useState<readonly ProviderWriteAction[]>([]);
  const [targetActions, setTargetActions] = useState<readonly ProviderWriteAction[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [subscription, setSubscription] = useState("");
  const [subscriptionTarget, setSubscriptionTarget] = useState<SubscriptionTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [last, setLast] = useState<ProviderWriteRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const session = useRef(-1);
  const mounted = useRef(false);
  const subscriptionInput = useRef("");
  const subscriptionRequest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeProviderSessions(id => {
      if (id !== providerId || session.current === -1 || session.current === providerSessionRevision(id)) return;
      subscriptionRequest.current++;
      setSubscriptionTarget(null); setAccount(""); setNotice("账号已变化，请关闭后重新读取");
    });
    return () => { mounted.current = false; subscriptionRequest.current++; unsubscribe(); };
  }, [providerId]);
  useEffect(() => {
    let active = true;
    void nativeProviderStatus(providerId).then(async status => {
      if (!active) return;
      if (status.state !== "ready") { setNotice("请先登录该来源账号"); return; }
      const revision = providerSessionRevision(providerId);
      if (session.current !== -1 && session.current !== revision) { setAccount(""); setNotice("账号已变化，请关闭后重新读取"); return; }
      session.current = revision; setAccount(status.account.id); setCapabilities(status.capabilities.writeActions);
      const result = await nativeProviderLibraryContainers(providerId, "created", page, 50);
      if (!active || revision !== providerSessionRevision(providerId)) return;
      setContainers(prev => page === 1 ? [...result.items] : [...new Map([...prev, ...result.items].map(c => [c.id, c])).values()]);
      setMore(result.hasMore && page < 100);
    }).catch(() => { if (active) setNotice("容器读取失败，请关闭后重新读取"); });
    return () => { active = false; };
  }, [providerId, page]);
  useEffect(() => {
    let active = true; setTargetActions([]);
    if (!target || !account) return;
    const revision = session.current;
    void nativeProviderContainer(providerId, target).then(detail => {
      if (active && detail.id === target && detail.providerId === providerId && detail.ownership === "created" && detail.owner.id === account && revision === providerSessionRevision(providerId)) setTargetActions(detail.allowedActions);
    }).catch(() => {});
    return () => { active = false; };
  }, [providerId, target, account]);
  async function submit(operation: ProviderWriteOperation, verify = false) {
    if (guard.current || !account || session.current !== providerSessionRevision(providerId)) return;
    const request = verify ? last : { providerId, accountId: account, operation };
    if (!request) return;
    guard.current = true; setBusy(true); setLast(request);
    const revision = session.current;
    const label = operation.kind === "setLiked" ? track.title : "containerId" in operation ? operation.containerId : track.title;
    setNotice(`正在${verify ? "只读核对" : "提交"}：${track.title} → ${label}`);
    try {
      const result = await nativeProviderWrite(request, verify);
      if (revision !== providerSessionRevision(providerId)) { setAccount(""); setNotice("账号已变化，旧操作结果不会更新当前账号"); return; }
      setNotice(result.status === "applied" ? `已核实目标状态：${track.title} → ${label}` : `结果待核对：${track.title} → ${label}。可能部分完成；请只读核对或到平台查看，应用不会重复提交。`);
      if (result.status === "applied" && providerId === "netease") {
        if (request.operation.kind === "setLiked") playerActions.applyVerifiedProviderLike(request.operation.trackId, request.operation.liked);
        void playerActions.refreshProviderLikes(true);
      }
    } catch (error) {
      if (revision === providerSessionRevision(providerId)) {
        const reason = error instanceof ProviderAdapterError && error.upstreamCode === "entitlement_denied" ? "当前账号无权编辑该容器；未发送写入" : error instanceof ProviderAdapterError && ["authentication_required", "credential_invalid"].includes(error.upstreamCode ?? "") ? "账号未就绪，请重新确认登录" : "操作未获确认，请只读核对；未自动重复提交";
        setNotice(`${reason}：${track.title} → ${label}`);
      }
    } finally { guard.current = false; setBusy(false); }
  }
  function currentSubscriptionRead(request: number, input: string, revision: number) {
    return mounted.current && request === subscriptionRequest.current && input === subscriptionInput.current
      && revision === session.current && revision === providerSessionRevision(providerId);
  }
  async function readSubscription() {
    if (!account || session.current !== providerSessionRevision(providerId)) return;
    const input = subscriptionInput.current;
    const request = ++subscriptionRequest.current, revision = session.current;
    const id = input.startsWith("netease:playlist:") ? input : `netease:playlist:${input}`;
    setSubscriptionTarget(null); setNotice(`正在读取目标歌单：${id}`);
    try {
      const result = await nativeProviderContainer("netease", id);
      if (!currentSubscriptionRead(request, input, revision)) return;
      if (result.providerId !== "netease" || result.id !== id) throw new Error("subscription_target_mismatch");
      setSubscriptionTarget({ container: result, input, request, revision });
      setNotice(`已读取目标歌单：${result.title}（${result.id}）`);
    } catch {
      if (!currentSubscriptionRead(request, input, revision)) return;
      setSubscriptionTarget(null); setNotice("歌单读取失败，请检查 ID 与账号状态");
    }
  }
  const verifiedSubscription = subscriptionTarget && currentSubscriptionRead(subscriptionTarget.request, subscriptionTarget.input, subscriptionTarget.revision)
    ? subscriptionTarget.container : null;
  function submitSubscription(subscribed: boolean) {
    if (!subscriptionTarget || !currentSubscriptionRead(subscriptionTarget.request, subscriptionTarget.input, subscriptionTarget.revision)) return;
    void submit({ kind: "setSubscribed", containerId: subscriptionTarget.container.id, subscribed });
  }
  const disabled = busy || Boolean(last) || !account;
  const add = providerId === "netease" ? "playlist.addTracks" : "favorite.addVideos";
  const remove = providerId === "netease" ? "playlist.removeTracks" : "favorite.removeVideos";
  return <div className="provider-library-form">
    <p className="provider-library-form__title">{providerId === "bilibili" ? "视频本体（同一 BV 的所有分 P 共用收藏状态）" : "网易歌曲"}：{track.title}</p>
    <PlaylistPicker options={[...new Map([...(initialContainer ? [initialContainer] : []), ...containers].map(c => [c.id, { id: c.id, title: c.title }])).values()]} value={target} onChange={setTarget} label={providerId === "bilibili" ? "目标自建收藏夹" : "目标自建歌单"} variant={variant} />
    {more && <button className="text-button" type="button" disabled={busy} onClick={() => setPage(p => p + 1)}>读取更多容器</button>}
    <div className="provider-library-buttons">
      <button className="text-button text-button--primary" type="button" disabled={disabled || !target || !capabilities.includes(add) || !targetActions.includes(add)} onClick={() => void submit({ kind: "addItems", containerId: target, trackIds: [track.id] })}>确认添加</button>
      <button className="text-button" type="button" disabled={disabled || !target || !capabilities.includes(remove) || !targetActions.includes(remove)} onClick={() => void submit({ kind: "removeItems", containerId: target, trackIds: [track.id] })}>确认移出</button>
      {providerId === "netease" && <>
        <button className="text-button" type="button" disabled={disabled || !capabilities.includes("song.like")} onClick={() => void submit({ kind: "setLiked", trackId: track.id, liked: true })}>喜欢此歌曲</button>
        <button className="text-button" type="button" disabled={disabled || !capabilities.includes("song.unlike")} onClick={() => void submit({ kind: "setLiked", trackId: track.id, liked: false })}>取消喜欢此歌曲</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => void playerActions.refreshProviderLikes(true)}>只读刷新喜欢列表</button>
      </>}
    </div>
    {providerId === "netease" && <fieldset className="provider-library-fieldset" disabled={disabled}>
      <legend>已有网易歌单的订阅状态</legend>
      <div className="provider-library-subscription-row">
        <label className="provider-library-field">歌单 ID<input value={subscription} onChange={e => {
          subscriptionInput.current = e.target.value; subscriptionRequest.current++;
          setSubscription(e.target.value); setSubscriptionTarget(null); setNotice("");
        }} /></label>
        <button className="text-button" type="button" onClick={() => void readSubscription()}>读取目标歌单</button>
      </div>
      {verifiedSubscription && <p className="provider-library-verified">已核对目标：{verifiedSubscription.title}（{verifiedSubscription.id}）</p>}
      <div className="provider-library-buttons">
        <button className="text-button text-button--primary" type="button" disabled={!verifiedSubscription || !capabilities.includes("playlist.subscribe")} onClick={() => submitSubscription(true)}>确认收藏歌单</button>
        <button className="text-button" type="button" disabled={!verifiedSubscription || !capabilities.includes("playlist.unsubscribe")} onClick={() => submitSubscription(false)}>确认取消收藏歌单</button>
      </div>
    </fieldset>}
    {last && <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void submit(last.operation, true)}>只读核对结果</button>}
    <p className="provider-library-status" role="status">{notice || "请选择目标后确认；每次操作均重新核对账号与权限。"}</p>
  </div>;
}
export function ProviderLibraryActions({ track, variant = "default", initialContainer }: { track: Track | null | undefined; variant?: "default" | "rhine"; initialContainer?: ProviderContainer }) {
  const [captured, setCaptured] = useState<Track | null>(null);
  const providerId = captured ? trackProvider(captured.id) : track ? trackProvider(track.id) : null;
  if (isRemotePlayback() || (providerId !== "netease" && providerId !== "bilibili")) return null;
  return <div className="provider-library-actions" data-variant={variant}>
    <button className={variant === "rhine" ? "rhine-action-pill provider-library-trigger" : "text-button provider-library-trigger"} type="button" aria-expanded={Boolean(captured)} onClick={() => setCaptured(captured ? null : track ? { ...track } : null)}>{captured ? "关闭云端操作" : providerId === "bilibili" ? "添加到收藏夹 / 移出" : "网易喜欢 / 歌单操作"}</button>
    {captured && <Form key={captured.id} track={captured} providerId={providerId} variant={variant} initialContainer={initialContainer} />}
  </div>;
}
