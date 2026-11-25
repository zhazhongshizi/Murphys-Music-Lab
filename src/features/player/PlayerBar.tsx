import type { CSSProperties } from "react";
import { CommitRange } from "./CommitRange";
import { PlaybackNotice } from "./PlaybackNotice";
import { SourceBadge } from "../providers/SourceBadge";
import { DeckPlaylistAction } from "../rhine/DeckPlaylistAction";

import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import { AlbumArtwork } from "../stage/AlbumArtwork";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import { isRemotePlayback } from "../../backend/playbackTransport";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
  type PlaybackMode,
} from "./playerStore";

/**
 * Layout mode for `PlayerBar`:
 * - `"stage"`: desktop standard-mode ListeningStage centered capsule (collapses cover/title/artist above 600px).
 * - `"dock"`: desktop standard-mode library/artist full-width docked bar (default).
 * - `"remote"`: LAN Remote WebUI bar (uses base + `remote.css` breakpoints, never morphed into stage capsule).
 */
export type PlayerBarVariant = "stage" | "dock" | "remote";

interface PlayerBarProps {
  onOpenQueue: () => void;
  onOpenStage?: () => void;
  queueOpen: boolean;
  accountKey?: string;
  authenticated?: boolean;
  variant?: PlayerBarVariant;
}

const MODE_LABELS: Record<PlaybackMode, string> = {
  sequence: "顺序播放",
  "repeat-all": "列表循环",
  "repeat-one": "单曲循环",
  shuffle: "随机播放",
};

function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

const selectPosition = (snapshot: PlayerSnapshot) => snapshot.positionMs;
const selectMode = (snapshot: PlayerSnapshot) => snapshot.mode;
const selectIsPlaying = (snapshot: PlayerSnapshot) => snapshot.isPlaying;
const selectMuted = (snapshot: PlayerSnapshot) => snapshot.muted;
const selectVolume = (snapshot: PlayerSnapshot) => snapshot.volume;
const selectQueueLength = (snapshot: PlayerSnapshot) => snapshot.queue.length;
const selectPlaybackError = (snapshot: PlayerSnapshot) => snapshot.playbackError;
const selectLikedIds = (snapshot: PlayerSnapshot) => snapshot.likedIds;
const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;
const selectLikesReady = (snapshot: PlayerSnapshot) => snapshot.likesReady;
const selectNeteaseLikesReady = (snapshot: PlayerSnapshot) => snapshot.neteaseLikesReady;
const selectLikePendingIds = (snapshot: PlayerSnapshot) => snapshot.likePendingIds;
const selectLikeNotice = (snapshot: PlayerSnapshot) => snapshot.likeNotice;

function PlayerTimeline({ track }: { track: NonNullable<ReturnType<typeof getCurrentTrack>> }) {
  const positionMs = usePlayerSelector(selectPosition);
  return (
    <div className="player-bar__timeline">
      <span>{formatTime(positionMs)}</span>
      <CommitRange
        aria-label="播放进度"
        max={track.durationMs}
        min="0"
        onCommit={playerActions.seek}
        style={{
          "--range-progress": `${track.durationMs === 0 ? 0 : (positionMs / track.durationMs) * 100}%`,
        } as CSSProperties}
        type="range"
        value={positionMs}
      />
      <span>{formatTime(track.durationMs)}</span>
    </div>
  );
}

export function PlayerBar({
  onOpenQueue,
  onOpenStage,
  queueOpen,
  accountKey,
  authenticated = true,
  variant = "dock",
}: PlayerBarProps) {
  const track = usePlayerSelector(getCurrentTrack);
  const mode = usePlayerSelector(selectMode);
  const isPlaying = usePlayerSelector(selectIsPlaying);
  const muted = usePlayerSelector(selectMuted);
  const volume = usePlayerSelector(selectVolume);
  const queueLength = usePlayerSelector(selectQueueLength);
  const playbackError = usePlayerSelector(selectPlaybackError);
  const likedIds = usePlayerSelector(selectLikedIds);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const likesReady = usePlayerSelector(selectLikesReady);
  const neteaseLikesReady = usePlayerSelector(selectNeteaseLikesReady);
  const likePendingIds = usePlayerSelector(selectLikePendingIds);
  const likeNotice = usePlayerSelector(selectLikeNotice);

  if (!track) return null;

  const modeIcon = mode === "shuffle" ? "shuffle" : mode === "sequence" ? "sequence" : "repeat";
  const canLike = !isRemotePlayback() && !localMusicFormatFromId(track.id) && !track.id.startsWith("bilibili:");
  const liked = likedIds.includes(track.id);
  const currentLikesReady = track.id.startsWith("netease:") ? neteaseLikesReady : likesReady;
  const likeDisabled = nativeMode && (!currentLikesReady || Boolean(likePendingIds?.includes(track.id)));
  const likeTooltip = nativeMode && !currentLikesReady
    ? "喜欢状态尚未读取，可打开喜欢页重新读取"
    : liked
      ? "取消喜欢"
      : "喜欢";

  return (
    <footer className="player-bar" aria-label="播放器控制" data-variant={variant}>
      <PlaybackNotice />
      <div className="player-bar__track">
        {onOpenStage ? (
          <Tooltip content="返回舞台">
            <button
              aria-label="返回播放舞台"
              className="player-bar__stage-cover"
              onClick={onOpenStage}
              type="button"
            >
              <AlbumArtwork compact track={track} />
            </button>
          </Tooltip>
        ) : (
          <AlbumArtwork compact track={track} />
        )}
        <div className="player-bar__track-meta">
          <div className="player-bar__title-row">
            {onOpenStage ? (
              <button
                aria-label={`返回舞台查看《${track.title}》`}
                className="player-bar__stage-title"
                onClick={onOpenStage}
                type="button"
              >
                <strong>{track.title}</strong>
              </button>
            ) : (
              <strong>{track.title}</strong>
            )}
            <SourceBadge track={track} />
            {canLike ? (
              <div className="player-bar__like-wrap">
                {likeNotice ? (
                  <span className="player-bar__like-notice" role="status">{likeNotice}</span>
                ) : null}
                <Tooltip content={likeTooltip}>
                  <button
                    aria-label={liked ? `取消喜欢《${track.title}》` : `喜欢《${track.title}》`}
                    aria-pressed={liked}
                    className={liked ? "icon-button player-bar__like player-bar__liked" : "icon-button icon-button--quiet player-bar__like"}
                    disabled={likeDisabled}
                    onClick={() => playerActions.toggleLike(track.id)}
                    type="button"
                  >
                    <Icon name="heart" size={16} />
                  </button>
                </Tooltip>
              </div>
            ) : null}
          </div>
          <span className="player-bar__artist"><SongArtistLinks track={track} />{track.actualQuality === "QQ MV 音轨" ? " · QQ MV 音轨" : ""}</span>
        </div>
      </div>

      <div className="player-bar__center">
        {playbackError ? (
          <div className="player-bar__error" role="alert">
            <span>{playbackError.message}</span>
            <button className="text-button" onClick={playerActions.retryPlayback} type="button">重试播放</button>
          </div>
        ) : null}
        <PlayerTimeline key={track.id} track={track} />
        <div className="player-bar__transport">
          <Tooltip content={MODE_LABELS[mode]}>
            <button
              aria-label={`${MODE_LABELS[mode]}，点击切换模式`}
              className="icon-button icon-button--quiet player-bar__mode"
              onClick={playerActions.cycleMode}
              type="button"
            >
              <Icon name={modeIcon} size={18} />
              <span>{mode === "repeat-one" ? "1" : null}</span>
            </button>
          </Tooltip>
          <Tooltip content="上一首">
            <button aria-label="上一首" className="icon-button player-bar__prev" onClick={playerActions.previous} type="button">
              <Icon name="previous" />
            </button>
          </Tooltip>
          <Tooltip content={isPlaying ? "暂停" : "播放"}>
            <button
              aria-label={isPlaying ? "暂停" : "播放"}
              className="icon-button player-bar__play"
              onClick={playerActions.toggle}
              type="button"
            >
              <Icon name={isPlaying ? "pause" : "play"} size={22} />
            </button>
          </Tooltip>
          <Tooltip content="下一首">
            <button aria-label="下一首" className="icon-button player-bar__next" onClick={playerActions.next} type="button">
              <Icon name="next" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="player-bar__tools">
        <div className="player-bar__library"><DeckPlaylistAction key={accountKey} track={track} authenticated={authenticated} variant="default" iconOnly /></div>
        <div className="player-bar__volume-group">
          <Tooltip content={muted ? "取消静音" : "静音"}>
            <button
              aria-label={muted ? "取消静音" : "静音"}
              className="icon-button icon-button--quiet player-bar__mute"
              onClick={playerActions.toggleMute}
              type="button"
            >
              <Icon name={muted ? "mute" : "volume"} size={18} />
            </button>
          </Tooltip>
          <div className="player-bar__volume">
            <label className="sr-only" htmlFor="player-volume">音量</label>
            <CommitRange
              id="player-volume"
              max="1"
              min="0"
              onCommit={playerActions.setVolume}
              step="0.01"
              style={{ "--range-progress": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
              type="range"
              value={muted ? 0 : volume}
            />
          </div>
        </div>
        <Tooltip content="播放队列">
          <button
            aria-controls="player-queue-dialog"
            aria-expanded={queueOpen}
            aria-label="打开播放队列"
            className="queue-button"
            onClick={onOpenQueue}
            type="button"
          >
            <Icon name="queue" size={18} />
            <span>{queueLength}</span>
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
