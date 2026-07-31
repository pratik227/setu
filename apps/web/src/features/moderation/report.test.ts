import { Kind } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  MAX_REPORT_COMMENT,
  REPORT_TYPE_COPY,
  REPORT_TYPES,
} from "./report";

const AUTHOR = "a".repeat(64);
const NOTE = "e".repeat(64);
const REPORTER = "9".repeat(64);

describe("buildReport", () => {
  it("puts the report type on the p tag when reporting an account", () => {
    const result = buildReport({ type: "impersonation", pubkey: AUTHOR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.kind).toBe(Kind.Report);
    expect(result.template.tags).toEqual([["p", AUTHOR, "impersonation"]]);
  });

  it("puts the type on the e tag when reporting an event, and names the author", () => {
    const result = buildReport({
      type: "spam",
      pubkey: AUTHOR,
      event: { id: NOTE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["e", NOTE, "spam"],
      ["p", AUTHOR],
    ]);
  });

  it("lowercases hex, so a pasted uppercase key still resolves", () => {
    const result = buildReport({
      type: "spam",
      pubkey: AUTHOR.toUpperCase(),
      event: { id: NOTE.toUpperCase() },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["e", NOTE, "spam"],
      ["p", AUTHOR],
    ]);
  });

  it("carries the comment as content, trimmed and bounded", () => {
    const result = buildReport({
      type: "other",
      pubkey: AUTHOR,
      comment: `  ${"x".repeat(MAX_REPORT_COMMENT + 50)}  `,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.content).toHaveLength(MAX_REPORT_COMMENT);
  });

  it("publishes an empty content when there is no comment", () => {
    const result = buildReport({ type: "spam", pubkey: AUTHOR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.content).toBe("");
  });

  it("refuses a target that is not 32-byte hex", () => {
    expect(buildReport({ type: "spam", pubkey: "nope" })).toEqual({
      ok: false,
      reason: "invalid-target",
    });
    expect(
      buildReport({ type: "spam", pubkey: AUTHOR, event: { id: "nope" } }),
    ).toEqual({ ok: false, reason: "invalid-target" });
  });

  it("refuses a type NIP-56 does not define", () => {
    expect(
      buildReport({
        // Deliberately outside the union: reports arrive from UI state, and an
        // unknown string would otherwise be published as a type nobody consumes.
        type: "harassment" as never,
        pubkey: AUTHOR,
      }),
    ).toEqual({ ok: false, reason: "unknown-type" });
  });

  it("refuses a report about the reporter", () => {
    expect(
      buildReport({ type: "spam", pubkey: REPORTER, reporter: REPORTER }),
    ).toEqual({ ok: false, reason: "self-report" });
  });

  it("has reader-facing copy for every type it accepts", () => {
    for (const type of REPORT_TYPES) {
      expect(REPORT_TYPE_COPY[type].label.length).toBeGreaterThan(0);
      expect(REPORT_TYPE_COPY[type].hint.length).toBeGreaterThan(0);
    }
  });
});
