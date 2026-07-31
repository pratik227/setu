import { supportsMuteIngest } from "@setu/core";
import type { Hex32 } from "@setu/protocol";
import { useEffect } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import { useMuteRules } from "./useMuteList";

/**
 * Hands the reader's mute list to the store, so muted noise is refused before it is
 * written.
 *
 * This is the last mile of the mute feature. `MuteIngestPolicy` decided *what* may be
 * refused and `muteFilter` decided *whether* a given event matches; neither had a
 * caller, so a muted account's reactions were still being fetched, verified, stored
 * and indexed, and only dropped one layer from the screen. `muteIngest.ts` explains
 * why the refusable set is reactions, reposts and zap receipts and nothing else — in
 * particular why refusing a *reply* would corrupt threads the reader is in.
 *
 * ## Forward-looking, and visibly so
 *
 * The list arrives from the relays some seconds after the store starts accepting
 * events, so a muted author's reactions received in that window are already stored,
 * and nothing here evicts them. That is deliberate rather than a gap: eviction would
 * turn every mute into an irreversible delete of data the reader can only get back if
 * a relay still holds it. The counts stay correct regardless — `useInteractions`
 * applies the same rules when it tallies, so what slipped past ingest is still
 * excluded from every number on screen.
 *
 * ## Mounted once, at the app root
 *
 * Not inside a screen. The store is written to by every subscription in the app, most
 * of them nowhere near the surface a reader muted somebody from, so a policy that
 * only applies while some component is mounted would apply almost never. One effect
 * at the root, re-run when the list or the account changes.
 */
export function useMuteIngest(): void {
  const engine = useEngine();
  const { session } = useSession();
  const { rules, rulesKey } = useMuteRules();
  const viewer = session?.pubkey as Hex32 | undefined;

  useEffect(() => {
    // Feature-detected rather than assumed: `setMuteRules` is a capability, and a
    // store without it is a valid store. See `MuteAwareEventStore`.
    if (!supportsMuteIngest(engine.store)) return;
    engine.store.setMuteRules(rules, viewer);
    // `rulesKey` rather than `rules` is the honest dependency: `useMuteRules` already
    // returns one object identity per version of the list, but the key is what
    // *defines* two rule sets as the same, and depending on it means an equal list
    // rebuilt after an account switch does not re-run this for nothing.
  }, [engine, rules, rulesKey, viewer]);
}
