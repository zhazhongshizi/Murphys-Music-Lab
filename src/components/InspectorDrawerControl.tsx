import { useCallback, useState } from "react";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

export interface InspectorDrawerState {
  readonly inspectorOpen: boolean;
  readonly setInspectorOpen: (open: boolean) => void;
  readonly openInspector: () => void;
  readonly closeInspector: () => void;
  readonly toggleInspector: () => void;
}

export function useInspectorDrawer(defaultOpen = false): InspectorDrawerState {
  const [inspectorOpen, setInspectorOpen] = useState(defaultOpen);
  const openInspector = useCallback(() => setInspectorOpen(true), []);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const toggleInspector = useCallback(() => setInspectorOpen((prev) => !prev), []);

  return {
    inspectorOpen,
    setInspectorOpen,
    openInspector,
    closeInspector,
    toggleInspector,
  };
}

export interface InspectorToggleButtonProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly controlsId?: string;
}

export function InspectorToggleButton({
  open,
  onToggle,
  controlsId,
}: InspectorToggleButtonProps) {
  return (
    <button
      aria-controls={controlsId}
      aria-expanded={open}
      aria-label="曲目检视栏"
      className={open ? "text-button catalog-inspector-toggle catalog-inspector-toggle--active" : "text-button catalog-inspector-toggle"}
      onClick={onToggle}
      type="button"
    >
      <Icon name="eye" size={16} />
      <span>曲目检视</span>
    </button>
  );
}

export interface InspectorHeaderBarProps {
  readonly label: string;
  readonly onClose?: () => void;
}

export function InspectorHeaderBar({ label, onClose }: InspectorHeaderBarProps) {
  return (
    <div className="catalog-inspector__topbar">
      <span className="section-label">{label}</span>
      {onClose ? (
        <Tooltip content="收起检视栏">
          <button
            aria-label="收起检视栏"
            className="icon-button icon-button--quiet catalog-inspector__close"
            onClick={onClose}
            type="button"
          >
            <Icon name="close" size={15} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
