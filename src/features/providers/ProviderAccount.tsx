import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AuthSnapshot } from "../../contracts/auth";
import type { NewProviderId, ProviderQrImage } from "../../contracts/providers";
import {
  nativeProviderCancel,
  nativeProviderCheck,
  nativeProviderLogin,
  nativeProviderLogout,
  nativeProviderPoll,
  ProviderAdapterError,
} from "../../backend/providersAdapter";
import { Icon } from "../../components/Icon";
import { providerErrorMessages, providerPersistenceMessage } from "../../contracts/providerErrors";
import { LoginDialog } from "../auth/LoginDialog";
import { SOURCE_LABELS, useDesktopProviders } from "./DesktopProviders";

function AccountTabs() {
  const { source, selectSource } = useDesktopProviders();
  return (
    <nav className="provider-sources provider-account-tabs" aria-label="平台账号">
      {(["qqmusic", "netease", "bilibili"] as const).map(id => (
        <button type="button" key={id} aria-pressed={source === id} onClick={() => selectSource(id)}>
          {SOURCE_LABELS[id]}
        </button>
      ))}
    </nav>
  );
}

function Account({ id }: { id: NewProviderId }) {
  const { snapshots, refresh } = useDesktopProviders();
  const status = snapshots[id];
  const [qr, setQr] = useState<ProviderQrImage | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const activeSession = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef(false);
  const attempted = useRef(false);

  function stop() {
    generation.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const session = activeSession.current;
    activeSession.current = null;
    if (session) void nativeProviderCancel(id, session).catch(() => {});
  }

  useEffect(() => {
    void refresh(id);
    return stop;
  }, [id]);

  useEffect(() => {
    if (!status || status.state !== "disabled" || attempted.current) return;
    // Defer until committed; StrictMode's discarded mount must not start a QR.
    const start = setTimeout(() => {
      attempted.current = true;
      void login();
    }, 0);
    return () => clearTimeout(start);
  }, [id, status?.state]);

  function errorText(error: unknown) {
    return error instanceof ProviderAdapterError && error.upstreamCode
      ? providerErrorMessages[error.upstreamCode]
      : "操作未完成，请手动查看账号状态";
  }

  async function login() {
    if (writing.current) return;
    stop();
    setQr(null);
    writing.current = true;
    setBusy(true);
    setNotice("正在获取二维码…");
    const epoch = generation.current;
    try {
      attempted.current = true;
      const image = await nativeProviderLogin(id);
      if (generation.current !== epoch) {
        void nativeProviderCancel(id, image.sessionId).catch(() => {});
        return;
      }
      activeSession.current = image.sessionId;
      setQr(image);
      setNotice("请使用对应平台手机应用扫码");
      const poll = async () => {
        if (generation.current !== epoch) return;
        if (Date.now() >= image.expiresAtMs) {
          stop();
          setQr(null);
          setNotice("二维码已过期，请手动重新获取");
          return;
        }
        try {
          const state = await nativeProviderPoll(id, image.sessionId);
          if (generation.current !== epoch) return;
          if (state.state === "authenticated") {
            activeSession.current = null;
            setQr(null);
            setNotice(`登录成功，${providerPersistenceMessage(state.persistence)}`);
            await refresh(id);
            return;
          }
          if (!["waitingScan", "waitingConfirmation"].includes(state.state)) {
            stop();
            setQr(null);
            setNotice("登录已结束，请手动重新获取二维码");
            return;
          }
          setNotice(state.state === "waitingConfirmation" ? "已扫码，请在手机确认" : "等待扫码");
          timer.current = setTimeout(() => {
            void poll();
          }, Math.max(1000, image.pollAfterMs));
        } catch (error) {
          if (generation.current !== epoch) return;
          stop();
          setQr(null);
          setNotice(errorText(error));
          await refresh(id);
        }
      };
      timer.current = setTimeout(() => {
        void poll();
      }, Math.max(1000, image.pollAfterMs));
    } catch (error) {
      if (generation.current === epoch) {
        setNotice(errorText(error));
        await refresh(id);
      }
    } finally {
      writing.current = false;
      if (generation.current === epoch) setBusy(false);
    }
  }

  async function action(kind: "check" | "logout") {
    if (writing.current) return;
    stop();
    setQr(null);
    writing.current = true;
    setBusy(true);
    const epoch = generation.current;
    try {
      const result = kind === "check" ? await nativeProviderCheck(id) : await nativeProviderLogout(id);
      if (kind === "logout") attempted.current = false;
      if (generation.current !== epoch) return;
      setNotice(
        kind === "check"
            ? result
              ? "登录仍有效"
              : "登录已失效，请重新扫码"
            : "已退出此平台，其他来源保持不变",
      );
      await refresh(id);
    } catch (error) {
      if (generation.current === epoch) {
        setNotice(errorText(error));
        await refresh(id);
      }
    } finally {
      writing.current = false;
      if (generation.current === epoch) setBusy(false);
    }
  }

  return (
    <section className="provider-account" aria-label={`${SOURCE_LABELS[id]}账号`}>
      <div className="provider-account__summary">
        {status?.state === "ready" ? (
          <span aria-hidden="true" className="login-dialog__success-mark">✓</span>
        ) : null}
        <h3>{SOURCE_LABELS[id]}</h3>
        <p>
          {status?.state === "ready"
            ? `${status.account.displayName} · ${status.account.id} · ${providerPersistenceMessage(status.persistence)}`
            : status && "error" in status && status.error
              ? providerErrorMessages[status.error]
              : status?.state === "restoring"
                ? "正在恢复登录…"
                : "此来源尚未登录"}
        </p>
        {status && "retryAfterMs" in status && status.retryAfterMs ? (
          <p className="provider-account__cooldown">
            平台冷却约 {Math.ceil(status.retryAfterMs / 1000)} 秒，请稍后手动操作
          </p>
        ) : null}
      </div>

      {qr && (
        <div className="login-dialog__qr provider-account__qr">
          <div className="login-dialog__qr-frame">
            <img
              className="provider-qr"
              alt={`${SOURCE_LABELS[id]}登录二维码`}
              src={`data:${qr.mimeType};base64,${qr.imageBase64}`}
            />
          </div>
        </div>
      )}

      <div className="provider-account__actions">
        {status?.state === "ready" ? (
          <>
            <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void action("check")}>
              检查登录有效性
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void action("logout")}>
              退出此平台
            </button>
          </>
        ) : null}
      </div>
      {status?.state !== "ready" && !qr && (
        <div className="provider-account__placeholder">
          {busy || !attempted.current ? <p>正在获取二维码…</p> : (
            <button className="text-button" type="button" onClick={() => void login()}>重新获取二维码</button>
          )}
        </div>
      )}
      <p className="provider-account__notice" role="status">{notice}</p>
    </section>
  );
}

export function DesktopAccountDialog({
  auth,
  onAuthChange,
  onClose,
  variant,
}: {
  auth: AuthSnapshot;
  onAuthChange: (auth: AuthSnapshot) => void;
  onClose: () => void;
  variant: "default" | "rhine";
}) {
  const { source } = useDesktopProviders();
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [source]);

  function keys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (event.key !== "Tab") return;
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }

  if (source === "qqmusic" || source === "local") {
    return (
      <LoginDialog
        auth={auth}
        onAuthChange={onAuthChange}
        onClose={onClose}
        accountNavigation={<AccountTabs />}
        variant={variant}
      />
    );
  }

  return createPortal(
    <div className="login-overlay" data-variant={variant}>
      <section
        ref={root}
        className="login-dialog provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="平台账号"
        onKeyDown={keys}
      >
        <header className="login-dialog__header">
          <div>
            <span className="section-label">PLATFORM ACCOUNT</span>
            <h2>平台账号</h2>
          </div>
          <button
            className="icon-button icon-button--quiet"
            type="button"
            aria-label="关闭登录窗口"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <AccountTabs />
        <Account key={source} id={source} />
      </section>
    </div>,
    document.body,
  );
}
