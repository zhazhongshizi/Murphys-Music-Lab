import { useEffect, useRef, useState } from "react";
import { changeCollections, previewQueue, switchQueue } from "../../backend/personalAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { usePlayerSelector } from "../player/playerStore";
import { useCollections } from "./useCollections";
import "./saved-queues.css";

const savedTime = (ms?: number) => ms ? new Date(ms).toLocaleString() : "保存时间未知";

export function SavedQueues({ compact = false }: { compact?: boolean }) {
  const { data, error, refresh } = useCollections();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewQueue>> | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [page, setPage] = useState(1);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [openMoreName, setOpenMoreName] = useState<string | null>(null);
  const pending = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const queue = usePlayerSelector(s => s.queue);

  useEffect(refresh, [queue, refresh]);

  useEffect(() => subscribePlaybackConnection(() => {
    setPreview(null);
    setPreviewName("");
    setNotice("");
    setRenamingName(null);
    setRenameText("");
    setConfirmDeleteName(null);
    setOpenMoreName(null);
  }), []);

  useEffect(() => {
    if (!data?.queues) return;
    const names = new Set(data.queues.map(q => q.name));
    setRenamingName(curr => {
      if (curr && !names.has(curr)) {
        setRenameText("");
        return null;
      }
      return curr;
    });
    setConfirmDeleteName(curr => (curr && !names.has(curr) ? null : curr));
    setOpenMoreName(curr => (curr && !names.has(curr) ? null : curr));
  }, [data?.queues]);

  useEffect(() => {
    if (renamingName) renameInputRef.current?.focus();
  }, [renamingName]);

  useEffect(() => {
    if (confirmDeleteName) cancelDeleteRef.current?.focus();
  }, [confirmDeleteName]);

  const exists = !!data?.queues.some(q => q.name === name.trim());

  async function run(action: () => Promise<unknown>, message: string) {
    if (pending.current) return;
    const identity = playbackSessionIdentity();
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await action();
      if (identity === playbackSessionIdentity()) {
        setNotice(message);
        refresh();
      }
    } catch {
      if (identity === playbackSessionIdentity()) {
        setNotice("操作未完成：请检查名称是否重复、队列容量或连接后重试");
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function inspect(targetName?: string) {
    const identity = playbackSessionIdentity();
    const value = await previewQueue(targetName);
    if (identity === playbackSessionIdentity()) {
      setPreview(value);
      setPreviewName(targetName ?? "上一份队列");
      setPage(1);
    }
  }

  function startRename(targetName: string) {
    setConfirmDeleteName(null);
    setRenamingName(targetName);
    setRenameText(targetName);
  }

  function cancelRename() {
    setRenamingName(null);
    setRenameText("");
  }

  async function commitRename(originalName: string) {
    const nextName = renameText.trim();
    if (!nextName) return;
    if (nextName === originalName) {
      cancelRename();
      return;
    }
    if (data?.queues.some(q => q.name === nextName)) return;
    await run(async () => {
      await changeCollections({ action: "renameQueue", name: originalName, target: nextName });
      setRenamingName(null);
      setRenameText("");
      setOpenMoreName(curr => (curr === originalName ? nextName : curr));
      if (previewName === originalName) setPreviewName(nextName);
    }, "队列已重命名");
  }

  function startDeleteConfirm(targetName: string) {
    setRenamingName(null);
    setRenameText("");
    setConfirmDeleteName(targetName);
  }

  const queues = data?.queues ?? [];

  return (
    <section className={`saved-queues${compact ? " saved-queues--compact" : ""}`} aria-label="保存的播放队列">
      <details open={!compact}>
        <summary>保存的播放队列</summary>
        <div className="saved-queues-storage">
          <div className="saved-queues-module">
            <span className="saved-queues-label">当前队列 / 存储</span>
            <form
              onSubmit={e => {
                e.preventDefault();
                void run(
                  () => changeCollections({ action: "saveQueue", name: name.trim() }),
                  exists ? "已更新保存的队列" : "已保存当前队列",
                );
              }}
            >
              <input
                aria-label="队列名称"
                maxLength={40}
                placeholder="工作、通勤…"
                value={name}
                onChange={e => setName(e.target.value)}
              />
              <button type="submit" disabled={busy || !data || !name.trim() || !queue.length}>
                {exists ? "更新同名队列" : "保存当前队列"}
              </button>
            </form>
          </div>
          <div className="saved-queues-module">
            <span className="saved-queues-label">已存队列 / 调取</span>
            {queues.length > 0 ? (
              <ul className="saved-queues__list">
                {queues.map(item => {
                  const isRenaming = renamingName === item.name;
                  const isConfirmingDelete = confirmDeleteName === item.name;
                  const nextName = renameText.trim();
                  const renameConflict = !!nextName && nextName !== item.name && queues.some(q => q.name === nextName);
                  const canCommitRename = !!nextName && nextName !== item.name && !renameConflict;
                  const isPreviewing = !!preview && previewName === item.name;
                  const isMoreOpen = openMoreName === item.name;

                  return (
                    <li
                      key={item.name}
                      className="saved-queues__row"
                      data-more-open={compact && isMoreOpen ? "true" : undefined}
                    >
                      {isRenaming ? (
                        <div
                          className="saved-queues__inline-rename"
                          onKeyDown={event => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelRename();
                            } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                              event.preventDefault();
                              event.stopPropagation();
                              void commitRename(item.name);
                            }
                          }}
                        >
                          <input
                            ref={renameInputRef}
                            type="text"
                            className="saved-queues__rename-input"
                            aria-label={`输入队列 ${item.name} 的新名称`}
                            maxLength={40}
                            value={renameText}
                            disabled={busy}
                            onChange={e => setRenameText(e.target.value)}
                          />
                          {renameConflict && (
                            <span className="saved-queues__rename-conflict" role="status">
                              名称已存在
                            </span>
                          )}
                          <Tooltip content="确认重命名">
                            <button
                              type="button"
                              className="icon-button icon-button--quiet"
                              aria-label="确认重命名"
                              disabled={busy || !canCommitRename}
                              onClick={() => void commitRename(item.name)}
                            >
                              <Icon name="check" size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip content="取消重命名">
                            <button
                              type="button"
                              className="icon-button icon-button--quiet"
                              aria-label="取消重命名"
                              disabled={busy}
                              onClick={cancelRename}
                            >
                              <Icon name="close" size={14} />
                            </button>
                          </Tooltip>
                        </div>
                      ) : isConfirmingDelete ? (
                        <div
                          className="saved-queues__confirm-delete"
                          onKeyDown={event => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              setConfirmDeleteName(null);
                            }
                          }}
                        >
                          <span className="saved-queues__confirm-text">确认删除《{item.name}》？</span>
                          <div className="saved-queues__confirm-actions">
                            <button
                              type="button"
                              className="saved-queues__delete-confirm-btn"
                              aria-label={`确认删除队列 ${item.name}`}
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await changeCollections({ action: "deleteQueue", name: item.name });
                                  setConfirmDeleteName(null);
                                  setOpenMoreName(curr => (curr === item.name ? null : curr));
                                  if (previewName === item.name) {
                                    setPreview(null);
                                    setPreviewName("");
                                  }
                                }, "已删除保存的队列，可撤销最近一次删除")
                              }
                            >
                              删除
                            </button>
                            <button
                              ref={cancelDeleteRef}
                              type="button"
                              className="saved-queues__delete-cancel-btn"
                              aria-label={`取消删除队列 ${item.name}`}
                              disabled={busy}
                              onClick={() => setConfirmDeleteName(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="saved-queues__info">
                            <strong className="saved-queues__name">{item.name}</strong>
                            <span className="saved-queues__meta">{item.count} 首 · {savedTime(item.savedAtMs)}</span>
                          </div>
                          <div className="saved-queues__actions">
                            <Tooltip content="切换到此队列">
                              <button
                                type="button"
                                className="icon-button icon-button--quiet saved-queues__play"
                                aria-label={`切换到队列 ${item.name}`}
                                disabled={busy}
                                onClick={() => void run(() => switchQueue(item.name), "队列已切换，点击播放开始收听")}
                              >
                                <Icon name="play" size={14} />
                              </button>
                            </Tooltip>
                            {compact && (
                              <Tooltip content={isMoreOpen ? "收起队列操作" : "更多队列操作"}>
                                <button
                                  type="button"
                                  className="icon-button icon-button--quiet saved-queues__more"
                                  aria-label={`更多队列操作 ${item.name}`}
                                  aria-expanded={isMoreOpen}
                                  disabled={busy}
                                  onClick={() => setOpenMoreName(curr => (curr === item.name ? null : item.name))}
                                >
                                  <Icon name="more" size={14} />
                                </button>
                              </Tooltip>
                            )}
                            <div className="saved-queues__secondary-actions">
                              <Tooltip content={isPreviewing ? "收起预览" : "预览队列"}>
                                <button
                                  type="button"
                                  className="icon-button icon-button--quiet"
                                  aria-label={`预览队列 ${item.name}`}
                                  aria-pressed={isPreviewing}
                                  disabled={busy}
                                  onClick={() => {
                                    if (isPreviewing) {
                                      setPreview(null);
                                      setPreviewName("");
                                    } else {
                                      void run(() => inspect(item.name), "");
                                    }
                                  }}
                                >
                                  <Icon name="eye" size={14} />
                                </button>
                              </Tooltip>
                              <Tooltip content="重命名队列">
                                <button
                                  type="button"
                                  className="icon-button icon-button--quiet"
                                  aria-label={`重命名队列 ${item.name}`}
                                  disabled={busy}
                                  onClick={() => startRename(item.name)}
                                >
                                  <Icon name="edit" size={14} />
                                </button>
                              </Tooltip>
                              <Tooltip content="删除队列">
                                <button
                                  type="button"
                                  className="icon-button icon-button--quiet icon-button--danger"
                                  aria-label={`删除队列 ${item.name}`}
                                  disabled={busy}
                                  onClick={() => startDeleteConfirm(item.name)}
                                >
                                  <Icon name="trash" size={14} />
                                </button>
                              </Tooltip>
                            </div>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="saved-queues__empty">暂无已保存的队列</p>
            )}
          </div>
        </div>
        {data?.deletedQueue && (
          <p>
            最近删除：{data.deletedQueue}{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => changeCollections({ action: "undoDeleteQueue" }), "已撤销删除")}
            >
              撤销删除
            </button>
          </p>
        )}
        <div className="personal-actions saved-queues-recovery">
          <button type="button" disabled={busy || !data?.hasPrevious} onClick={() => void run(() => inspect(), "")}>
            预览上一份
          </button>
          <button
            type="button"
            disabled={busy || !data?.hasPrevious}
            onClick={() => void run(() => switchQueue(), "已恢复上一份队列")}
          >
            恢复上一份队列
          </button>
          {data?.previous && <span>上一份：{data.previous.count} 首 · {savedTime(data.previous.savedAtMs)}</span>}
        </div>
        {preview && (
          <div className="queue-preview" aria-label="队列预览">
            <h3>{previewName} · {preview.items.length} 首</h3>
            <p>{savedTime(preview.savedAtMs)} · 预览不改变播放</p>
            <ol start={(page - 1) * 20 + 1}>
              {preview.items.slice((page - 1) * 20, page * 20).map((track, i) => (
                <li key={track.id}>
                  {track.title} · {track.artist}
                  {preview.selectedIndex === (page - 1) * 20 + i && "（保存时选中）"}
                </li>
              ))}
            </ol>
            {!preview.items.length && <p>这是一份空队列</p>}
            <nav className="personal-actions" aria-label="队列预览分页">
              <button type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>上一页</button>
              <span>第 {page} 页</span>
              <button type="button" disabled={page * 20 >= preview.items.length} onClick={() => setPage(p => p + 1)}>下一页</button>
              <button type="button" onClick={() => { setPreview(null); setPreviewName(""); }}>关闭预览</button>
            </nav>
          </div>
        )}
        {!compact && (
          <p className="saved-queues-note">队列切换后暂停，保留保存时选中的歌曲；当前队列替换或清空后可恢复上一份。</p>
        )}
        {error && (
          <p role="alert">
            保存的队列读取失败 <button onClick={refresh} type="button">重试</button>
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </details>
    </section>
  );
}
