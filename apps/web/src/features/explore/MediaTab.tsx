import { cn, EmptyState, Skeleton } from "@setu/ui";
import { EyeOff, Image as ImageIcon, Play } from "lucide-react";
import { useState } from "react";
import type { MediaNote } from "./useMediaNotes";
import { useMediaNotes } from "./useMediaNotes";

/**
 * One media tile.
 *
 * A content-warned note stays covered until the reader asks, per NIP-36. In a
 * grid this matters more than in a timeline: a wall of thumbnails gives no
 * reading order, so an unblurred sensitive image is seen before any text
 * explaining it could be.
 */
function MediaTile({
  note,
  onOpenThread,
}: {
  note: MediaNote;
  onOpenThread?(id: string): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const first = note.media[0];
  if (!first) return null;
  const covered = Boolean(note.contentWarning) && !revealed;

  if (covered) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className={cn(
          "flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg",
          "border border-border/60 bg-muted/40 px-2 text-center",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        )}
      >
        <EyeOff className="size-4 text-muted-foreground" />
        <span className="line-clamp-3 text-2xs text-muted-foreground">
          {note.contentWarning}
        </span>
        <span className="text-2xs font-medium text-primary">Show anyway</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenThread?.(note.id)}
      title={note.content.slice(0, 200)}
      className={cn(
        "group/tile relative aspect-square overflow-hidden rounded-lg",
        "border border-border/60 bg-muted",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
      )}
    >
      {first.kind === "image" ? (
        <img
          src={first.url}
          alt={first.alt ?? ""}
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition-transform duration-(--motion-duration-standard) group-hover/tile:scale-105"
        />
      ) : (
        <>
          <video
            src={first.url}
            preload="metadata"
            muted
            className="size-full object-cover"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Play className="size-5 fill-white text-white" />
          </span>
        </>
      )}
      {note.media.length > 1 ? (
        <span className="absolute right-1 bottom-1 rounded-md bg-black/60 px-1.5 text-2xs text-white tabular-nums">
          +{note.media.length - 1}
        </span>
      ) : null}
    </button>
  );
}

export interface MediaTabProps {
  onOpenThread?(id: string): void;
}

export function MediaTab({ onOpenThread }: MediaTabProps) {
  const { notes, sampleSize, loading } = useMediaNotes(400);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-2 px-4 py-4 sm:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon className="size-6" />}
        title="No media in your local index"
        description={
          sampleSize === 0
            ? "No notes have reached this client at all, so there is nothing to scan. The relays are either still answering or unreachable."
            : `Scanned the newest ${sampleSize} notes in your index and none of them carried an image or a video. Media cannot be requested from a relay by filter — it is found by reading notes we already hold.`
        }
      />
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-4 pt-2.5 text-xs text-muted-foreground">
        {notes.length} of the newest {sampleSize} notes in your local index
        carry media. Found by tokenizing note text, not by asking a relay.
      </p>
      <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-3">
        {notes.map((note) => (
          <MediaTile key={note.id} note={note} onOpenThread={onOpenThread} />
        ))}
      </div>
    </div>
  );
}
