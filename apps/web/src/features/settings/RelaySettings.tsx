import { NIP, relayGate, supports } from "@setu/core";
import { Kind } from "@setu/protocol";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Panel,
  Spinner,
} from "@setu/ui";
import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { DEFAULT_RELAYS, useEngine } from "../../engine/EngineProvider";
import { usePublish } from "../compose/usePublish";
import {
  editDmRelayList,
  editRelayList,
  type RelayEntry,
  relayEntries,
} from "./relayListEdit";
import { refusalMessage, SaveRow, useOwnReplaceable } from "./settingsShared";

export function RelaySection() {
  const engine = useEngine();
  const { publish, state } = usePublish();
  const { event, absenceConfirmed } = useOwnReplaceable(Kind.RelayList);
  const [draft, setDraft] = useState<RelayEntry[] | undefined>();
  const [added, setAdded] = useState("");
  const [error, setError] = useState<string | undefined>();

  const seedKey = event?.id ?? (absenceConfirmed ? "none" : "");
  const [seeded, setSeeded] = useState("");
  if (seedKey !== "" && seedKey !== seeded) {
    setSeeded(seedKey);
    const existing = relayEntries(event);
    setDraft(
      existing.length > 0
        ? [...existing]
        : DEFAULT_RELAYS.map((url) => ({ url, read: true, write: true })),
    );
  }

  const busy = state.status === "signing" || state.status === "publishing";

  const save = useCallback(async () => {
    if (!draft) return;
    const result = editRelayList({
      current: event,
      absenceConfirmed,
      next: draft,
    });
    if (!result.ok) {
      setError(refusalMessage(result, "a relay list"));
      return;
    }
    setError(undefined);
    await publish(result.template);
  }, [draft, event, absenceConfirmed, publish]);

  return (
    <Panel title="Relays">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Where Setu reads your feed and publishes your notes (NIP-65). Other
          clients use this list to find you, so removing a relay makes your
          notes unreachable to whoever only reads it.
        </p>

        {draft === undefined ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Spinner size={16} aria-hidden />
            Loading your relay list.
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {draft.map((entry, index) => {
                const info =
                  engine.relayInfo.get(`${entry.url}/`) ??
                  engine.relayInfo.get(entry.url);
                const gate = relayGate(info);
                return (
                  <li
                    key={entry.url}
                    className="rounded-lg border border-border/60 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="setu-mono min-w-0 flex-1 truncate text-xs">
                        {entry.url}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${entry.url}`}
                        onClick={() =>
                          setDraft(draft.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          id={`read-${entry.url}`}
                          checked={entry.read}
                          onCheckedChange={(checked) =>
                            setDraft(
                              draft.map((e, i) =>
                                i === index
                                  ? { ...e, read: checked === true }
                                  : e,
                              ),
                            )
                          }
                        />
                        <Label
                          htmlFor={`read-${entry.url}`}
                          className="text-2xs"
                        >
                          Read
                        </Label>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          id={`write-${entry.url}`}
                          checked={entry.write}
                          onCheckedChange={(checked) =>
                            setDraft(
                              draft.map((e, i) =>
                                i === index
                                  ? { ...e, write: checked === true }
                                  : e,
                              ),
                            )
                          }
                        />
                        <Label
                          htmlFor={`write-${entry.url}`}
                          className="text-2xs"
                        >
                          Write
                        </Label>
                      </div>

                      {/* What the relay says about itself. Shown because it
                          explains behaviour a reader would otherwise blame on
                          the client. */}
                      {gate !== "none" ? (
                        <Badge variant="outline" className="text-2xs">
                          <ShieldAlert className="size-3" />
                          {gate === "payment-required"
                            ? "Payment required"
                            : "Login required"}
                        </Badge>
                      ) : null}
                      {supports(info, NIP.Count) ? (
                        <Badge variant="secondary" className="text-2xs">
                          Counts
                        </Badge>
                      ) : null}
                      {supports(info, NIP.Search) ? (
                        <Badge variant="secondary" className="text-2xs">
                          Search
                        </Badge>
                      ) : null}
                      {info?.limitation.maxLimit ? (
                        <span className="text-2xs text-muted-foreground">
                          max {info.limitation.maxLimit}/query
                        </span>
                      ) : null}
                    </div>

                    {gate !== "none" ? (
                      <p className="mt-1.5 text-2xs text-muted-foreground">
                        {gate === "payment-required"
                          ? "This relay answers queries with silence until you have a paid account, which looks the same as an empty network."
                          : "This relay needs NIP-42 login, which Setu does not support yet, so it will return nothing."}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="flex gap-2">
              <Input
                value={added}
                onChange={(e) => setAdded(e.target.value)}
                placeholder="wss://relay.example.com"
                aria-label="Relay URL to add"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={added.trim() === ""}
                onClick={() => {
                  const url = added.trim();
                  if (!draft.some((e) => e.url === url)) {
                    setDraft([...draft, { url, read: true, write: true }]);
                  }
                  setAdded("");
                }}
              >
                <Plus />
                Add
              </Button>
            </div>

            <SaveRow
              busy={busy}
              error={error}
              state={state}
              onSave={() => void save()}
              onDismiss={() => setError(undefined)}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

export function DmRelaySection() {
  const { publish, state } = usePublish();
  const { event, absenceConfirmed } = useOwnReplaceable(
    Kind.DirectMessageRelays,
  );
  const [draft, setDraft] = useState<string[] | undefined>();
  const [added, setAdded] = useState("");
  const [error, setError] = useState<string | undefined>();

  const seedKey = event?.id ?? (absenceConfirmed ? "none" : "");
  const [seeded, setSeeded] = useState("");
  if (seedKey !== "" && seedKey !== seeded) {
    setSeeded(seedKey);
    setDraft(
      (event?.tags ?? [])
        .filter((tag) => tag[0] === "relay" && tag[1])
        .map((tag) => tag[1] as string),
    );
  }

  const busy = state.status === "signing" || state.status === "publishing";

  const save = useCallback(async () => {
    if (!draft) return;
    const result = editDmRelayList({
      current: event,
      absenceConfirmed,
      next: draft,
    });
    if (!result.ok) {
      setError(refusalMessage(result, "a message relay list"));
      return;
    }
    setError(undefined);
    await publish(result.template);
  }, [draft, event, absenceConfirmed, publish]);

  return (
    <Panel title="Message relays">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Where you receive private messages (NIP-17). Kept separate from the
          list above on purpose — where you read public notes and where you want
          private mail delivered are different questions.
        </p>

        {draft === undefined ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Spinner size={16} aria-hidden />
            Loading your message relays.
          </div>
        ) : (
          <>
            {draft.length === 0 ? (
              <p className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs">
                You have not published any message relays, so nobody can send
                you a private message — a sender has nowhere to deliver to, and
                Setu will not guess on their behalf.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {draft.map((url, index) => (
                  <li
                    key={url}
                    className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5"
                  >
                    <span className="setu-mono min-w-0 flex-1 truncate text-xs">
                      {url}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${url}`}
                      onClick={() =>
                        setDraft(draft.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <Input
                value={added}
                onChange={(e) => setAdded(e.target.value)}
                placeholder="wss://inbox.example.com"
                aria-label="Message relay URL to add"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={added.trim() === ""}
                onClick={() => {
                  const url = added.trim();
                  if (!draft.includes(url)) setDraft([...draft, url]);
                  setAdded("");
                }}
              >
                <Plus />
                Add
              </Button>
            </div>

            <SaveRow
              busy={busy}
              error={error}
              state={state}
              onSave={() => void save()}
              onDismiss={() => setError(undefined)}
            />
          </>
        )}
      </div>
    </Panel>
  );
}
