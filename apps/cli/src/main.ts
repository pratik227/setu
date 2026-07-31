#!/usr/bin/env node
/**
 * `setu` — a headless client over `@setu/core`.
 *
 * This exists as a layer guard with teeth, not as a product. If a feature cannot
 * be driven from here, it has leaked into the UI layer. It is also the fastest
 * way to check behavior against real relays without a browser.
 *
 * Exit codes: 0 ok · 1 usage error · 2 network/relay failure.
 */

import { createEngine } from "@setu/core";
import {
  decodeAny,
  encodeNpub,
  isValidEventShape,
  Kind,
  tokenizeContent,
  verifyEventSignature,
} from "@setu/protocol";
import { createNodeSocket } from "./nodeSocket";

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
];

const USAGE = `setu — headless Nostr client

Usage:
  setu fetch [--kinds 1,6] [--authors <hex,…>] [--limit 20] [--relay <url>]…
  setu profile <npub|hex> [--relay <url>]…
  setu decode <npub1…|note1…|nevent1…|naddr1…>
  setu verify            read newline-delimited JSON events on stdin
  setu tokenize <text>

Options:
  --relay <url>   repeatable; defaults to ${DEFAULT_RELAYS.join(", ")}
  --json          machine-readable single-line JSON
  --timeout <ms>  network deadline (default 8000)
`;

interface Args {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly relays: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const relays: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    if (name === "relay") {
      if (!takesValue) continue;
      relays.push(next);
      i++;
      continue;
    }
    if (takesValue) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    relays: relays.length > 0 ? relays : DEFAULT_RELAYS,
    flags,
  };
}

function numberFlag(args: Args, name: string, fallback: number): number {
  const raw = args.flags[name];
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFlag(args: Args, name: string): string[] | undefined {
  const raw = args.flags[name];
  if (typeof raw !== "string") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve an npub or hex string to a hex pubkey. */
function toHexPubkey(input: string): string | undefined {
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  const decoded = decodeAny(input);
  if (!decoded) return undefined;
  if (decoded.type === "npub" || decoded.type === "nprofile") {
    return decoded.pubkey;
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withEngine<T>(
  args: Args,
  run: (engine: ReturnType<typeof createEngine>) => Promise<T>,
): Promise<T> {
  const engine = createEngine({
    relays: args.relays,
    createSocket: createNodeSocket,
    onError: (scope, error) => {
      if (args.flags.verbose) console.error(`! ${scope}:`, error);
    },
  });
  try {
    return await run(engine);
  } finally {
    engine.close();
  }
}

async function cmdFetch(args: Args): Promise<number> {
  const kinds = (listFlag(args, "kinds") ?? ["1"]).map(Number);
  const authors = listFlag(args, "authors")
    ?.map(toHexPubkey)
    .filter((v): v is string => Boolean(v));
  const limit = numberFlag(args, "limit", 20);
  const timeout = numberFlag(args, "timeout", 8000);

  return withEngine(args, async (engine) => {
    const filter = {
      kinds,
      limit,
      ...(authors && authors.length > 0 ? { authors } : {}),
    };
    const filters = args.relays.map((relay) => ({ relay, filter }));

    const events = await Promise.race([
      engine.subscriptions.fetch({ filters }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeout),
      ),
    ]).catch((error) => {
      console.error(`network: ${(error as Error).message}`);
      return undefined;
    });

    if (!events) return 2;

    const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
    if (args.flags.json) {
      console.log(JSON.stringify(sorted));
      return 0;
    }

    console.log(
      `${sorted.length} verified event(s) from ${args.relays.length} relay(s)\n`,
    );
    for (const event of sorted) {
      const when = new Date(event.created_at * 1000).toISOString();
      const npub = encodeNpub(event.pubkey) ?? event.pubkey;
      const oneLine = event.content.replace(/\s+/g, " ").slice(0, 160);
      console.log(`${when}  kind ${event.kind}  ${npub.slice(0, 20)}…`);
      console.log(`  ${oneLine}\n`);
    }
    return 0;
  });
}

async function cmdProfile(args: Args): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    console.error("usage: setu profile <npub|hex>");
    return 1;
  }
  const pubkey = toHexPubkey(target);
  if (!pubkey) {
    console.error(`not a pubkey: ${target}`);
    return 1;
  }

  return withEngine(args, async (engine) => {
    const filter = {
      kinds: [Kind.Metadata, Kind.RelayList],
      authors: [pubkey],
    };
    const events = await engine.subscriptions.fetch({
      filters: args.relays.map((relay) => ({ relay, filter })),
    });

    const metadata = events
      .filter((e) => e.kind === Kind.Metadata)
      .sort((a, b) => b.created_at - a.created_at)[0];
    const relayList = events
      .filter((e) => e.kind === Kind.RelayList)
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (args.flags.json) {
      console.log(JSON.stringify({ metadata, relayList }));
      return metadata ? 0 : 2;
    }

    if (!metadata) {
      console.error("no kind-0 metadata found on the queried relays");
      return 2;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(metadata.content);
    } catch {
      console.error("kind-0 content is not valid JSON");
    }
    console.log(`npub    ${encodeNpub(pubkey)}`);
    for (const key of ["name", "display_name", "nip05", "about"]) {
      const value = parsed[key];
      if (typeof value === "string" && value) {
        console.log(`${key.padEnd(13)}${value.replace(/\s+/g, " ")}`);
      }
    }
    if (relayList) {
      const urls = relayList.tags
        .filter((t) => t[0] === "r")
        .map((t) => t[1])
        .filter(Boolean);
      console.log(`relays  ${urls.join(", ") || "(none listed)"}`);
    }
    return 0;
  });
}

function cmdDecode(args: Args): number {
  const input = args.positional[0];
  if (!input) {
    console.error("usage: setu decode <nip19 entity>");
    return 1;
  }
  const decoded = decodeAny(input);
  if (!decoded) {
    console.error(`could not decode: ${input}`);
    return 1;
  }
  console.log(JSON.stringify(decoded, null, args.flags.json ? 0 : 2));
  return 0;
}

async function cmdVerify(args: Args): Promise<number> {
  const input = await readStdin();
  const lines = input.split("\n").filter((l) => l.trim());
  let ok = 0;
  let bad = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad++;
      if (!args.flags.json) console.log("invalid  (not JSON)");
      continue;
    }
    if (!isValidEventShape(parsed)) {
      bad++;
      if (!args.flags.json) console.log("invalid  (bad event shape)");
      continue;
    }
    const valid = verifyEventSignature(parsed);
    if (valid) ok++;
    else bad++;
    if (!args.flags.json) {
      console.log(`${valid ? "valid  " : "INVALID"}  ${parsed.id}`);
    }
  }

  if (args.flags.json) console.log(JSON.stringify({ ok, bad }));
  else console.log(`\n${ok} valid, ${bad} invalid`);
  return bad > 0 ? 1 : 0;
}

function cmdTokenize(args: Args): number {
  const text = args.positional.join(" ");
  if (!text) {
    console.error("usage: setu tokenize <text>");
    return 1;
  }
  const tokens = tokenizeContent(text);
  if (args.flags.json) {
    console.log(JSON.stringify(tokens));
    return 0;
  }
  for (const token of tokens) {
    const shown = token.value.replace(/\n/g, "\\n");
    console.log(`${token.type.padEnd(10)} ${JSON.stringify(shown)}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "fetch":
      return cmdFetch(args);
    case "profile":
      return cmdProfile(args);
    case "decode":
      return cmdDecode(args);
    case "verify":
      return cmdVerify(args);
    case "tokenize":
      return cmdTokenize(args);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return args.command ? 0 : 1;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.log(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
