/**
 * Building a NIP-56 report (kind 1984).
 *
 * ## What a report is, and what it is not
 *
 * A kind-1984 is a signed, **public** note saying "I think this is X", addressed to
 * whoever happens to be listening — relay operators who read reports, and clients
 * that consume them. That is the whole mechanism. It does not delete the event, does
 * not hide it from the reporter, does not block the author, and every relay is free
 * to ignore it entirely. Nothing anywhere is obliged to answer.
 *
 * That gap between what the button looks like and what it does is the thing this
 * module and its dialog exist to keep honest. A UI that says "Report" and then shows
 * a checkmark has told the reader moderation happened; the only truthful
 * confirmation is that the report was *published*, which is a statement about
 * relays accepting an event and nothing more.
 *
 * ## Tag shape
 *
 * NIP-56 puts the report type in the third position of the tag naming *what* is
 * being reported:
 *
 *  - reporting a person: `["p", <pubkey>, <type>]`
 *  - reporting an event: `["e", <id>, <type>]` plus `["p", <author>]` with no type,
 *    because the type describes the event, not a judgement about the account.
 *
 * Only tags NIP-56 defines are emitted. Extra tags of our own invention would be
 * ignored by every consumer and are indistinguishable, to a relay operator reading
 * a report queue, from a client that has misunderstood the spec.
 */

import { type EventTemplate, type Hex32, isHex32, Kind } from "@setu/protocol";

/** The report types NIP-56 defines. Nothing else is a valid report type. */
export const REPORT_TYPES = [
  "spam",
  "nudity",
  "profanity",
  "illegal",
  "impersonation",
  "malware",
  "other",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Reader-facing wording for each type.
 *
 * Written as descriptions of the *content*, not as accusations about the person:
 * a report is read by a stranger with no context, and "this account is illegal" is
 * not a claim anyone can act on.
 */
export const REPORT_TYPE_COPY: Readonly<
  Record<ReportType, { readonly label: string; readonly hint: string }>
> = {
  spam: {
    label: "Spam",
    hint: "Bulk, repetitive or unsolicited posting.",
  },
  nudity: {
    label: "Nudity or sexual content",
    hint: "Explicit imagery, posted without a content warning.",
  },
  profanity: {
    label: "Profanity or hateful speech",
    hint: "Slurs and abuse directed at people.",
  },
  illegal: {
    label: "Something illegal",
    hint: "Content that is likely unlawful where the relay operates.",
  },
  impersonation: {
    label: "Impersonation",
    hint: "Pretending to be someone else, including a copied name and picture.",
  },
  malware: {
    label: "Malware or a scam link",
    hint: "Links that attack the reader's device, wallet or keys.",
  },
  other: {
    label: "Something else",
    hint: "Describe it below — nobody can act on a report with no detail.",
  },
};

export interface ReportInput {
  readonly type: ReportType;
  /** The account being reported, or the author of the reported event. */
  readonly pubkey: Hex32;
  /** The event being reported. Omit to report the account alone. */
  readonly event?: { readonly id: Hex32 };
  /** Free text from the reporter. Published in the clear. */
  readonly comment?: string;
  /** The reporter, so a report about themselves can be refused. */
  readonly reporter?: Hex32;
}

export type ReportRefusal =
  /** The pubkey or event id was not 32-byte hex. */
  | "invalid-target"
  /** Not one of the NIP-56 types. */
  | "unknown-type"
  /** Reporting yourself carries no meaning to anyone reading reports. */
  | "self-report";

export type ReportResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: ReportRefusal };

/**
 * Longest comment we will publish.
 *
 * Not a protocol limit — relays impose their own, and a report rejected for size
 * after the reader typed an essay is a worse outcome than a bounded box that says
 * so up front.
 */
export const MAX_REPORT_COMMENT = 500;

/** Build the kind-1984 for one report. */
export function buildReport(input: ReportInput): ReportResult {
  if (!REPORT_TYPES.includes(input.type)) {
    return { ok: false, reason: "unknown-type" };
  }
  const pubkey = input.pubkey.toLowerCase();
  const eventId = input.event?.id.toLowerCase();
  if (!isHex32(pubkey) || (eventId !== undefined && !isHex32(eventId))) {
    return { ok: false, reason: "invalid-target" };
  }
  if (input.reporter !== undefined && input.reporter.toLowerCase() === pubkey) {
    return { ok: false, reason: "self-report" };
  }

  const tags: string[][] =
    eventId === undefined
      ? [["p", pubkey, input.type]]
      : // The type sits on the `e` tag; the `p` tag only says whose event it was.
        [
          ["e", eventId, input.type],
          ["p", pubkey],
        ];

  return {
    ok: true,
    template: {
      kind: Kind.Report,
      content: (input.comment ?? "").trim().slice(0, MAX_REPORT_COMMENT),
      tags,
    },
  };
}
