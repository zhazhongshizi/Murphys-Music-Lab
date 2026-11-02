import { trackProvider } from "../../contracts/providerIdentity";
import type { VideoPartMetadata } from "../../contracts/providers";
import { SOURCE_LABELS } from "./DesktopProviders";
export function SourceBadge({ track }: { track: { id: string; video?: VideoPartMetadata } }) {
  const source = trackProvider(track.id);
  const label = `${source ? SOURCE_LABELS[source] : "未知来源"}${track.video ? ` · P${track.video.partNumber}` : ""}`;
  return <span className="provider-badge" aria-label="曲目来源" title={track.video ? `${label} · ${track.video.partTitle}` : label}>{label}</span>;
}
