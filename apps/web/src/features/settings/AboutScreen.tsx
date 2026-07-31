import { ScrollArea } from "@setu/ui";
import { AboutSection } from "./AboutSettings";

/**
 * About, as its own destination.
 *
 * It was the last panel on the settings page, which meant it was reachable only by
 * someone already scrolling past four forms for something else — so in practice nobody
 * found it. Who made a thing, and how to support it, is not a preference; it does not
 * belong among controls that publish events to relays.
 *
 * Deliberately reachable with no account: the panel states what Setu is and who wrote
 * it, and neither depends on being signed in.
 */
export function AboutScreen() {
  return (
    <ScrollArea className="px-4 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-12">
        <AboutSection />
      </div>
    </ScrollArea>
  );
}
