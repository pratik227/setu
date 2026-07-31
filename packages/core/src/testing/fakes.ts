/**
 * Fake `RelayPool` and `SubscriptionManager` implementations for tests.
 *
 * Not part of the public barrel. These let the subscription manager be tested
 * without a socket, and the feed engine without a subscription manager.
 */

import type { NostrEvent, RelayBasedFilter } from "@setu/protocol";
import type {
  EventStore,
  PublishResult,
  ReadRequest,
  RelayHealth,
  RelayPool,
  SubscriptionCallbacks,
  SubscriptionHandle,
  SubscriptionManager,
} from "../contracts";
import { matchesFilter } from "../internal/filterMatch";
import type { RelayCountResult } from "../relay/countRequests";
import { compareEventsNewestFirst } from "../store/replaceable";

/** Records what the subscription manager asked of the transport. */
export class FakeRelayPool implements RelayPool {
  /** Every `subscribe` call, in order. */
  readonly requests: {
    readonly id: string;
    readonly filters: readonly RelayBasedFilter[];
  }[] = [];
  /** Every `publish` call, in order. */
  readonly publishCalls: {
    readonly event: NostrEvent;
    readonly relays: readonly string[];
  }[] = [];
  readonly connectCalls: string[][] = [];
  closed = false;
  /** Override to control (or stall) publish resolution. */
  publishResult: (
    event: NostrEvent,
    relays: readonly string[],
  ) => Promise<readonly PublishResult[]> = async (_event, relays) =>
    relays.map((relay) => ({ relay, ok: true }));

  private readonly callbacks = new Map<string, SubscriptionCallbacks>();
  private next = 1;

  async connect(urls: readonly string[]): Promise<void> {
    this.connectCalls.push([...urls]);
  }

  subscribe(
    filters: readonly RelayBasedFilter[],
    callbacks: SubscriptionCallbacks,
  ): SubscriptionHandle {
    const id = `fake-${this.next++}`;
    this.requests.push({ id, filters });
    this.callbacks.set(id, callbacks);
    return {
      id,
      close: () => {
        this.callbacks.delete(id);
      },
    };
  }

  async publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<readonly PublishResult[]> {
    this.publishCalls.push({ event, relays });
    return this.publishResult(event, relays);
  }

  /** Records COUNT requests; answers with whatever `countAnswers` holds. */
  readonly countCalls: RelayBasedFilter[][] = [];
  countAnswers: readonly RelayCountResult[] = [];

  async count(
    filters: readonly RelayBasedFilter[],
  ): Promise<readonly RelayCountResult[]> {
    this.countCalls.push([...filters]);
    return this.countAnswers;
  }

  health(): readonly RelayHealth[] {
    return [];
  }

  block(): void {}
  unblock(): void {}

  close(): void {
    this.closed = true;
  }

  /** Id of the most recent subscription. */
  get lastId(): string {
    const last = this.requests[this.requests.length - 1];
    if (last === undefined) throw new Error("no subscriptions issued");
    return last.id;
  }

  /** Filters of the most recent subscription. */
  get lastFilters(): readonly RelayBasedFilter[] {
    const last = this.requests[this.requests.length - 1];
    if (last === undefined) throw new Error("no subscriptions issued");
    return last.filters;
  }

  /** Delivers an event on a subscription. */
  emit(event: NostrEvent, relay: string, id: string = this.lastId): void {
    this.callbacks.get(id)?.onEvent?.(event, relay);
  }

  /** Signals EOSE for one relay. */
  eose(relay: string, id: string = this.lastId): void {
    this.callbacks.get(id)?.onEose?.(relay);
  }

  /** Signals that every relay is done. */
  complete(id: string = this.lastId): void {
    this.callbacks.get(id)?.onComplete?.();
  }
}

/**
 * A `SubscriptionManager` that serves a fixed set of "network" events out of
 * memory, honouring each filter including `until` and `limit`.
 *
 * Good enough to exercise pagination and staging without a pool or a socket.
 */
export class FakeSubscriptions implements SubscriptionManager {
  /** Every `fetch` request, in order — assert pagination windows against this. */
  readonly fetches: ReadRequest[] = [];
  /** Every `subscribe` request, in order. */
  readonly subscribes: ReadRequest[] = [];
  /** Events the "network" holds. */
  network: NostrEvent[] = [];
  readonly published: NostrEvent[] = [];

  constructor(private readonly store: EventStore) {}

  subscribe(request: ReadRequest): SubscriptionHandle {
    this.subscribes.push(request);
    return { id: `fake-sub-${this.subscribes.length}`, close: () => undefined };
  }

  async fetch(request: ReadRequest): Promise<readonly NostrEvent[]> {
    this.fetches.push(request);
    const matched = new Map<string, NostrEvent>();
    for (const { filter } of request.filters) {
      const hits = this.network
        .filter((event) => matchesFilter(event, filter))
        .sort(compareEventsNewestFirst)
        .slice(0, filter.limit ?? Number.MAX_SAFE_INTEGER);
      for (const event of hits) matched.set(event.id, event);
    }
    const events = [...matched.values()];
    await this.store.putAll(events, "wss://fake");
    return events;
  }

  async publish(event: NostrEvent): Promise<readonly PublishResult[]> {
    this.published.push(event);
    await this.store.put(event);
    return [];
  }
}
