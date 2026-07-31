import { Panel } from "@setu/ui";
import { ExternalLink, Github, Heart } from "lucide-react";

/**
 * Who made this, and how to support it.
 *
 * Its own file rather than another section in `SettingsScreen`, which has already been
 * split once for crossing the 700-line ceiling. It is also the only panel on the
 * screen that changes with the *project* rather than with the reader's settings, so
 * keeping it separate means a credit or a link can be edited without touching a form
 * that writes to relays.
 *
 * ## Everything here is a fact from a page the author controls
 *
 * The name, the description and the links are taken from the author's own GitHub and
 * sponsors profiles. Nothing is inferred: an "about" panel is the one place in a client
 * where a wrong claim is a claim about a real person, and inventing a title or a
 * location to fill the layout would be exactly that. Where a detail was not stated on
 * those pages, it is absent here rather than guessed.
 *
 * ## Why the sponsor link is stated plainly and once
 *
 * Setu is Apache-2.0 and free, and the author's stated goal is to work on open source
 * full time. A single honest line asking for that is different from the pattern this
 * panel deliberately avoids — a recurring prompt, a modal, or a badge on a nav item.
 * Funding belongs on the page you go to when you want to know who made something.
 */

/** External destinations, in one place so a dead link is one edit. */
const LINKS = {
  github: "https://github.com/pratik227",
  sponsors: "https://github.com/sponsors/pratik227",
  x: "https://x.com/PratikPatel_227",
  site: "https://pratik-patel.netlify.app/",
} as const;

/**
 * One outbound link.
 *
 * `noreferrer` alongside `noopener` on every one: these are the author's own pages, so
 * the tab-hijacking risk is not the point — the referrer is. A reader opening a sponsor
 * link should not hand the destination the fact that they were on a Nostr client's
 * settings screen, and that is a decision to make once here rather than per link.
 */
function AboutLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-foreground underline decoration-border hover:decoration-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {icon}
      {children}
    </a>
  );
}

export function AboutSection() {
  return (
    <Panel title="About Setu">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Setu</span> is Sanskrit
          for <em>bridge</em>. It is a Nostr client for the web and the desktop,
          licensed Apache-2.0 — free to use, read, fork and ship.
        </p>

        <div className="border-t border-border/60 pt-3">
          <p className="text-xs">
            <span className="font-medium">Pratik Patel</span>
            <span className="text-muted-foreground"> — founder</span>
          </p>
          {/* Verbatim from the author's own GitHub profile, so the description of a
              real person is theirs rather than one written for them here. */}
          <p className="mt-1 text-xs text-muted-foreground">
            “Solution developer. Part-time open-sourcerer.” Based in India,
            programming since 2013, and the author of{" "}
            <span className="font-mono text-2xs">nostr-core</span> along with a
            number of Quasar and Vue open-source projects.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <AboutLink href={LINKS.github} icon={<Github />}>
              github.com/pratik227
            </AboutLink>
            <AboutLink href={LINKS.x} icon={<ExternalLink />}>
              @PratikPatel_227
            </AboutLink>
            <AboutLink href={LINKS.site} icon={<ExternalLink />}>
              pratik-patel.netlify.app
            </AboutLink>
          </div>
        </div>

        <div className="border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">
            Setu is built in the open and asks nothing to use. If it is worth
            something to you, sponsoring is what makes more of it possible — the
            stated goal is open source full time.
          </p>
          <div className="mt-1.5">
            <AboutLink href={LINKS.sponsors} icon={<Heart />}>
              Sponsor on GitHub
            </AboutLink>
          </div>
        </div>

        <p className="text-2xs text-muted-foreground/80">
          No analytics, no tracking and no account with us: Setu talks to the
          relays you configure and to nothing else. The links above are the only
          thing on this screen that leaves the app, and only when you click one.
        </p>
      </div>
    </Panel>
  );
}
