import { cn } from "@setu/ui";
import { reservedAspectRatio } from "./noteMediaViews";
import type { MediaView } from "./types";

/**
 * A note's media grid.
 *
 * The one thing this component exists to do that a bare `<img>` does not: reserve
 * the box before the image loads. An image with no reserved space is zero pixels
 * tall until it decodes and then hundreds, so every row below it moves — once per
 * image, in whatever order the network delivers them. On a timeline being read
 * that is the difference between a page that settles and one that jumps under the
 * reader's eyes for several seconds.
 *
 * The reservation is an *aspect-ratio* box, never a fixed height. A fixed height
 * is wrong for every image that is not exactly that shape, so it trades a jump for
 * a crop or a gap; a ratio scales with the column and is correct at every width.
 * The ratio itself comes from the author's NIP-92 `dim`, clamped — see
 * `reservedAspectRatio`, and `parseDim` for what is rejected outright.
 *
 * Without a declared size nothing is reserved, which is the old behaviour: a
 * guessed ratio jumps just as much *and* crops.
 */
function MediaItem({ item }: { item: MediaView }) {
  const ratio = reservedAspectRatio(item);
  const reserved = ratio !== undefined;

  return (
    <div
      className={cn(
        "relative max-h-96 overflow-hidden bg-muted",
        reserved && "w-full",
      )}
      // Inline because the ratio is data from the event: Tailwind can only emit
      // classes it can see at build time, and this one is a stranger's number.
      style={reserved ? { aspectRatio: ratio } : undefined}
    >
      {item.kind === "image" ? (
        <img
          src={item.url}
          alt={item.alt ?? ""}
          loading="lazy"
          decoding="async"
          className={cn(
            "object-cover",
            // Filling the reserved box keeps the decoded image from resizing it;
            // without a reservation the image sizes the box as it always did.
            reserved ? "absolute inset-0 size-full" : "max-h-96 w-full",
          )}
        />
      ) : (
        <video
          src={item.url}
          controls
          preload="metadata"
          {...(item.width !== undefined ? { width: item.width } : {})}
          {...(item.height !== undefined ? { height: item.height } : {})}
          className={cn(
            reserved ? "absolute inset-0 size-full" : "max-h-96 w-full",
          )}
        />
      )}
    </div>
  );
}

/** One image goes full width; several tile into a 2-column grid. */
export function NoteMedia({
  media,
  className,
}: {
  media: readonly MediaView[];
  className?: string;
}) {
  if (media.length === 0) return null;
  return (
    <div
      className={cn(
        "mt-2 grid gap-1 overflow-hidden rounded-lg border border-border/60",
        media.length > 1 ? "grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {media.map((item) => (
        <MediaItem key={item.url} item={item} />
      ))}
    </div>
  );
}
