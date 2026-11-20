import type { MouseEvent } from "react";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

export interface TrackRowActionsProps {
  readonly title: string;
  readonly onPlay?: () => void;
  readonly onNext?: () => void;
  readonly onEnqueue?: () => void;
  readonly onRemove?: () => void;
  readonly disabled?: boolean;
  readonly playDisabled?: boolean;
  readonly nextDisabled?: boolean;
  readonly enqueueDisabled?: boolean;
  readonly removeDisabled?: boolean;
  readonly playLabel?: string;
  readonly playTooltip?: string;
  readonly nextLabel?: string;
  readonly nextTooltip?: string;
  readonly enqueueLabel?: string;
  readonly enqueueTooltip?: string;
  readonly removeLabel?: string;
  readonly removeTooltip?: string;
  readonly className?: string;
  readonly variant?: "default" | "rhine" | "compact";
  readonly stopPropagation?: boolean;
}

export function TrackRowActions({
  title,
  onPlay,
  onNext,
  onEnqueue,
  onRemove,
  disabled = false,
  playDisabled = false,
  nextDisabled = false,
  enqueueDisabled = false,
  removeDisabled = false,
  playLabel,
  playTooltip = "播放",
  nextLabel,
  nextTooltip = "下一首播放",
  enqueueLabel,
  enqueueTooltip = "加入队列",
  removeLabel,
  removeTooltip = "移出",
  className,
  variant = "default",
  stopPropagation = false,
}: TrackRowActionsProps) {
  const iconSize = variant === "compact" ? 15 : 16;
  const classes = [
    "track-row-actions",
    `track-row-actions--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  function handleAction(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      if (stopPropagation) {
        event.stopPropagation();
      }
      action();
    };
  }

  return (
    <div
      className={classes}
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
      onDoubleClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
    >
      {onPlay ? (
        <Tooltip content={playTooltip}>
          <button
            aria-label={playLabel ?? `播放 ${title}`}
            className="icon-button icon-button--quiet"
            disabled={disabled || playDisabled}
            onClick={handleAction(onPlay)}
            type="button"
          >
            <Icon name="play" size={iconSize} />
          </button>
        </Tooltip>
      ) : null}
      {onNext ? (
        <Tooltip content={nextTooltip}>
          <button
            aria-label={nextLabel ?? `下一首播放 ${title}`}
            className="icon-button icon-button--quiet"
            disabled={disabled || nextDisabled}
            onClick={handleAction(onNext)}
            type="button"
          >
            <Icon name="play-next" size={iconSize} />
          </button>
        </Tooltip>
      ) : null}
      {onEnqueue ? (
        <Tooltip content={enqueueTooltip}>
          <button
            aria-label={enqueueLabel ?? `加入队列 ${title}`}
            className="icon-button icon-button--quiet"
            disabled={disabled || enqueueDisabled}
            onClick={handleAction(onEnqueue)}
            type="button"
          >
            <Icon name="queue" size={iconSize} />
          </button>
        </Tooltip>
      ) : null}
      {onRemove ? (
        <Tooltip content={removeTooltip}>
          <button
            aria-label={removeLabel ?? `移除 ${title}`}
            className="icon-button icon-button--quiet icon-button--danger"
            disabled={disabled || removeDisabled}
            onClick={handleAction(onRemove)}
            type="button"
          >
            <Icon name="trash" size={iconSize} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
