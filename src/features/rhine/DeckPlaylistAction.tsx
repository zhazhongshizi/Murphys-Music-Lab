import { useEffect, useId, useRef, useState } from "react";
import { addSongsToPlaylist, getLibraryPlaylists, LibraryAdapterError } from "../../backend/libraryAdapter";
import { isRemotePlayback } from "../../backend/playbackTransport";
import type { PlaylistSummary } from "../../contracts/library";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import PlaylistPicker from "../library/PlaylistPicker";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";

type Song = { id: string; title: string };

function PlaylistForm({
  song,
  onClose,
  variant = "rhine",
}: {
  song: Song;
  onClose: () => void;
  variant?: "default" | "rhine";
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const writing = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void getLibraryPlaylists("created", page, 50).then(result => {
      if (!active) return;
      const editable = result.items.filter(item => item.editableId);
      setPlaylists(previous => {
        const combined = page === 1 ? editable : [...previous, ...editable];
        return [...new Map(combined.map(item => [item.id, item])).values()];
      });
      setTargetId(previous => previous || editable[0]?.id || "");
      setHasMore(result.hasMore && page < 100);
    }).catch(error => {
      if (!active) return;
      setLoadError(error instanceof LibraryAdapterError && error.code === "QMG-LIBRARY-AUTH"
        ? "请先登录账号，再添加到歌单。" : "歌单读取失败，请重试。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, retry]);

  async function add() {
    const target = playlists.find(item => item.id === targetId);
    if (!target?.editableId || writing.current) return;
    writing.current = true;
    setSubmitted(true);
    setNotice(`正在将“${song.title}”加入“${target.title}”…`);
    try {
      await addSongsToPlaylist(target.id, target.editableId, [song.id]);
      setNotice(`已将“${song.title}”加入“${target.title}”。`);
    } catch (error) {
      setNotice(error instanceof LibraryAdapterError && error.code === "QMG-LIBRARY-AUTH"
        ? "请先登录账号，再添加到歌单。"
        : "加入结果待核对，请查看目标歌单；应用没有自动重复提交。");
    }
  }

  return (
    <div className={variant === "default" ? "provider-library-form" : "rhine-deck-playlist-panel"}>
      <div className={variant === "default" ? "provider-library-heading" : "rhine-deck-playlist-heading"}>
        <strong>将歌曲添加进歌单</strong>
        <Tooltip content="关闭">
          <button
            type="button"
            className={variant === "default" ? "icon-button icon-button--quiet" : "icon-button icon-button--quiet rhine-deck-playlist-close"}
            onClick={onClose}
            aria-label="关闭添加歌单"
          >
            <Icon name="close" size={16} />
          </button>
        </Tooltip>
      </div>
      <p className={variant === "default" ? "provider-library-form__title" : "rhine-deck-playlist-song"} title={song.title}>
        {song.title}
      </p>
      <PlaylistPicker variant={variant} options={playlists} value={targetId} onChange={setTargetId} label="目标歌单" />
      <div className={variant === "default" ? "provider-library-buttons" : "rhine-deck-playlist-actions"}>
        {loadError
          ? <button type="button" className={variant === "default" ? "text-button" : undefined} onClick={() => setRetry(value => value + 1)}>重新读取歌单</button>
          : hasMore && <button type="button" className={variant === "default" ? "text-button" : undefined} disabled={loading} onClick={() => setPage(value => value + 1)}>更多歌单</button>}
        <button
          type="button"
          className={variant === "default" ? "text-button text-button--primary" : undefined}
          disabled={!targetId || submitted}
          onClick={() => void add()}
        >
          确认添加
        </button>
      </div>
      <p className={variant === "default" ? "provider-library-status" : undefined} role="status">
        {notice || loadError || (loading ? "正在读取歌单…" : playlists.length ? "选择目标歌单后确认添加。" : "还没有可添加的歌单，请先在音乐档案中创建歌单。")}
      </p>
    </div>
  );
}

export function DeckPlaylistAction({
  track,
  authenticated = true,
  variant = "rhine",
  iconOnly = false,
}: {
  track: Song | null | undefined;
  authenticated?: boolean;
  variant?: "default" | "rhine";
  iconOnly?: boolean;
}) {
  const [song, setSong] = useState<Song | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  if (isRemotePlayback()) return null;

  const available = Boolean(track && !localMusicFormatFromId(track.id) && authenticated);
  function close() {
    setSong(null);
    trigger.current?.focus();
  }

  const isProviderTrack = Boolean(track?.id.startsWith("netease:") || track?.id.startsWith("bilibili:"));

  if (variant === "default" && isProviderTrack) {
    return <ProviderLibraryActions track={track} variant={variant} iconOnly={iconOnly} />;
  }

  const qqTooltip = !authenticated
    ? "登录后可添加到歌单"
    : !available
      ? "请选择在线歌曲"
      : song
        ? "关闭添加歌单"
        : "加入 QQ 音乐歌单";

  const qqTriggerButton = iconOnly ? (
    <Tooltip content={qqTooltip}>
      <button
        ref={trigger}
        type="button"
        className={
          variant === "default"
            ? "icon-button icon-button--quiet provider-library-trigger provider-library-trigger--icon"
            : "rhine-playlist-icon-button provider-library-trigger provider-library-trigger--icon"
        }
        disabled={!available}
        aria-label="加入 QQ 音乐歌单"
        aria-expanded={Boolean(song)}
        aria-controls={song ? panelId : undefined}
        onClick={() => {
          if (song) close();
          else if (track) setSong({ id: track.id, title: track.title });
        }}
      >
        <Icon name="playlist-add" size={18} />
      </button>
    </Tooltip>
  ) : (
    <button
      ref={trigger}
      type="button"
      className={variant === "default" ? "text-button provider-library-trigger" : undefined}
      disabled={!available}
      aria-expanded={Boolean(song)}
      aria-controls={song ? panelId : undefined}
      title={!authenticated ? "登录后可添加到歌单" : !available ? "请选择在线歌曲" : undefined}
      onClick={() => {
        if (song) close();
        else if (track) setSong({ id: track.id, title: track.title });
      }}
    >
      将歌曲添加进歌单
    </button>
  );

  return (
    <>
      <ProviderLibraryActions track={track} variant={variant} iconOnly={iconOnly} />
      <div
        hidden={isProviderTrack}
        className={variant === "default" ? "provider-library-actions" : "rhine-deck-playlist"}
        data-variant={variant === "default" ? "default" : undefined}
        onKeyDown={event => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            close();
          }
        }}
      >
        {qqTriggerButton}
        {song && (
          <section id={panelId} aria-label="添加歌曲到歌单">
            <PlaylistForm song={song} onClose={close} variant={variant} />
          </section>
        )}
      </div>
    </>
  );
}
