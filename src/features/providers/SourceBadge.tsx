import { trackProvider } from "../../contracts/providerIdentity";
import type { VideoPartMetadata } from "../../contracts/providers";
import { SOURCE_LABELS } from "./DesktopProviders";
export function SourceBadge({ track }: { track: { id: string; video?: VideoPartMetadata } }) {
  const source = trackProvider(track.id);
  return <span className="provider-badge" aria-label="曲目来源">{source ? SOURCE_LABELS[source] : "未知来源"}{track.video ? ` · P${track.video.partNumber} · ${track.video.partTitle}` : ""}</span>;
}
