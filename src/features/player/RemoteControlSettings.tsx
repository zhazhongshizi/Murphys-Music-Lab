import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { encodeQrMatrix, qrMatrixToPathData } from "./qrSvg";
import "./remote-control.css";

interface RemoteStatus {
  enabled: boolean;
  addresses: string[];
  pairingCode: string | null;
}

const OFF: RemoteStatus = { enabled: false, addresses: [], pairingCode: null };
const COPY_FEEDBACK_MS = 1600;
const QR_QUIET_ZONE = 4;

async function requestStatus(command: "remote_status" | "remote_set_enabled", enabled?: boolean): Promise<RemoteStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<unknown>(command, enabled === undefined ? {} : { enabled });
  if (!value || typeof value !== "object") throw new Error("读取遥控状态失败");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !== "addresses,enabled,pairingCode"
    || typeof data.enabled !== "boolean"
    || !Array.isArray(data.addresses)
    || !data.addresses.every((a) => typeof a === "string" && /^http:\/\/[\d.]+:\d+$/.test(a))
    || !(data.pairingCode === null || (typeof data.pairingCode === "string" && /^[a-f0-9]{32}$/.test(data.pairingCode)))
  ) {
    throw new Error("读取遥控状态失败");
  }
  return data as unknown as RemoteStatus;
}

export function RemoteControlSettings() {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const baseId = useId();
  const [status, setStatus] = useState(OFF);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const clearCopyTimer = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearCopyTimer, [clearCopyTimer]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    void requestStatus("remote_status")
      .then(
        (s) => {
          if (active) setStatus(s);
        },
        () => {
          if (active) setError("读取遥控状态失败，请重新打开设置");
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [native]);

  useEffect(() => {
    setQrOpen(false);
  }, [status.enabled, status.pairingCode]);

  async function toggle() {
    clearCopyTimer();
    setBusy(true);
    setError("");
    setCopiedKey(null);
    try {
      setStatus(await requestStatus("remote_set_enabled", !status.enabled));
    } catch (e) {
      setError(typeof e === "string" ? e : "遥控服务操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(key: string, text: string) {
    clearCopyTimer();
    setError("");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedKey((current) => (current === key ? null : current));
      }, COPY_FEEDBACK_MS);
    } catch {
      setCopiedKey(null);
      setError("复制失败，请选中地址和连接码手动复制");
    }
  }

  const primary = status.addresses.find((a) => !a.includes("127.0.0.1"));
  const baseAddress = primary ?? status.addresses[0] ?? "";
  const link = baseAddress ? `${baseAddress}/#code=${status.pairingCode ?? ""}` : "";

  const qrMatrix = useMemo(() => (qrOpen && link ? encodeQrMatrix(link) : null), [qrOpen, link]);
  const qrPath = useMemo(() => (qrMatrix ? qrMatrixToPathData(qrMatrix) : ""), [qrMatrix]);

  return (
    <>
      <div className="fixture-menu__divider" role="separator" />
      <span className="section-label">局域网遥控 · 测试版</span>
      <div className="remote-settings__switch-row">
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          aria-label="允许手机 / 平板遥控"
          className="settings-switch fixture-menu__item"
          disabled={!native || busy}
          onClick={() => void toggle()}
        >
          <span>{busy ? "正在连接播放核心…" : "允许手机 / 平板遥控"}</span>
          <span className="settings-switch__track" aria-hidden="true">
            <span className="settings-switch__thumb" />
          </span>
        </button>
      </div>
      {status.enabled && (
        <div
          className="remote-settings"
          role="group"
          aria-label="遥控连接信息"
          onKeyDown={(e) => {
            if (e.key !== "Escape") e.stopPropagation();
          }}
        >
          <p>手机与电脑连接同一网络。打开下方地址，输入连接码。声音由电脑播放。</p>
          {status.addresses.map((address, index) => {
            const isLoopback = address.includes("127.0.0.1");
            const fieldLabel = isLoopback ? "本机预览" : "手机访问地址";
            const isPrimary = primary ? address === primary : index === 0;
            const copyAriaLabel = isPrimary
              ? "复制地址"
              : isLoopback
                ? "复制本机预览地址"
                : `复制地址 ${address}`;
            const tooltipContent = isPrimary || !isLoopback ? "复制地址" : "复制本机预览地址";
            const copyId = `address:${address}`;
            const inputId = `${baseId}-addr-${index}`;
            return (
              <div className="remote-settings__field" key={address}>
                <label htmlFor={inputId}>{fieldLabel}</label>
                <div className="remote-settings__field-row">
                  <input
                    id={inputId}
                    readOnly
                    value={address}
                    onFocus={(e) => e.target.select()}
                  />
                  <Tooltip content={tooltipContent}>
                    <button
                      type="button"
                      className="icon-button icon-button--quiet remote-settings__copy-btn"
                      aria-label={copyAriaLabel}
                      onClick={() => void copyText(copyId, address)}
                    >
                      <Icon name={copiedKey === copyId ? "check" : "copy"} size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
          {!primary && <p>未识别到局域网地址，可使用电脑的 IPv4 地址加 :19653 访问。</p>}
          <div className="remote-settings__field">
            <label htmlFor={`${baseId}-code`}>连接码</label>
            <div className="remote-settings__field-row">
              <input
                id={`${baseId}-code`}
                readOnly
                value={status.pairingCode ?? ""}
                onFocus={(e) => e.target.select()}
              />
              <Tooltip content="复制连接码">
                <button
                  type="button"
                  className="icon-button icon-button--quiet remote-settings__copy-btn"
                  aria-label="复制连接码"
                  disabled={!status.pairingCode}
                  onClick={() => void copyText("code", status.pairingCode ?? "")}
                >
                  <Icon name={copiedKey === "code" ? "check" : "copy"} size={14} />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="remote-settings__actions">
            <button
              type="button"
              className="remote-settings__action-btn"
              aria-label="复制完整链接"
              disabled={!link}
              onClick={() => void copyText("link", link)}
            >
              <Icon name={copiedKey === "link" ? "check" : "copy"} size={14} />
              <span>{copiedKey === "link" ? "已复制完整链接" : "复制完整链接"}</span>
            </button>
            {link && (
              <button
                type="button"
                className="remote-settings__action-btn"
                aria-expanded={qrOpen}
                onClick={() => setQrOpen((open) => !open)}
              >
                <span>{qrOpen ? "收起二维码" : "显示二维码"}</span>
              </button>
            )}
          </div>
          {qrOpen && (
            <div className="remote-settings__qr remote-settings__qr-panel" role="region" aria-label="遥控连接二维码">
              {qrMatrix ? (
                <>
                  <div className="remote-settings__qr-frame">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox={`0 0 ${qrMatrix.size + QR_QUIET_ZONE * 2} ${qrMatrix.size + QR_QUIET_ZONE * 2}`}
                      shapeRendering="crispEdges"
                      role="img"
                      aria-label="遥控连接二维码图像"
                    >
                      <rect
                        width={qrMatrix.size + QR_QUIET_ZONE * 2}
                        height={qrMatrix.size + QR_QUIET_ZONE * 2}
                        fill="#ffffff"
                      />
                      <path
                        transform={`translate(${QR_QUIET_ZONE},${QR_QUIET_ZONE})`}
                        d={qrPath}
                        fill="#000000"
                      />
                    </svg>
                  </div>
                  <p className="remote-settings__qr-hint">手机扫码即连，含当前连接码，注意防截屏泄露</p>
                </>
              ) : (
                <p className="remote-settings__qr-fallback">
                  当前连接地址过长，暂不支持二维码，请使用文字地址与连接码
                </p>
              )}
            </div>
          )}
          <p>仅在可信局域网使用。关闭即断开所有设备；重启默认关闭。若无法连接，请检查专用网络防火墙与访客 Wi-Fi 隔离。</p>
        </div>
      )}
      {!native && <span className="section-label">请在桌面版开启</span>}
      {error && <span className="fixture-menu__error" role="alert">{error}</span>}
    </>
  );
}
