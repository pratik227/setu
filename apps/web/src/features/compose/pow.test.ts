import { describe, expect, it } from "vitest";
import {
  describePow,
  difficultyChoiceLabel,
  MAX_ATTEMPTABLE_DIFFICULTY,
  MAX_MINING_MS,
  MIN_MINING_MS,
  miningBudgetMs,
  miningLabel,
  miningPlan,
  POW_CHOICES,
  summarisePow,
  templateFromMined,
  unsignedForMining,
} from "./pow";

/**
 * The decisions around mining, tested where the worker cannot be.
 *
 * Each case names the breakage it prevents, because most of them are silent: an
 * event that mines for nothing, a wait nobody asked for, or a "sent" line claiming
 * work that is not in the id.
 */

/** An id with exactly `bits` leading zero bits, for grading a signed event. */
function idWithZeroBits(bits: number): string {
  const zeros = "0".repeat(Math.floor(bits / 4));
  const remainder = bits % 4;
  // 8 >> remainder gives the nibble whose own leading zeros are `remainder`.
  const boundary = remainder === 0 ? "f" : (8 >> remainder).toString(16);
  return `${zeros}${boundary}`.padEnd(64, "f");
}

const AUTHOR = "a".repeat(64);

describe("miningPlan", () => {
  // The default. Mining costs real time on every post, so anything other than an
  // explicit positive difficulty must leave the publish path untouched.
  it("is off for 0", () => {
    expect(miningPlan(0)).toEqual({ kind: "off" });
  });

  // A corrupt stored value or a fractional one reaching the miner would make every
  // post wait for work the user never configured — or, for 20.5, for a cost rounded
  // to whichever side happened to be chosen, where one bit is a factor of two.
  it.each([Number.NaN, 20.5, -3, Number.POSITIVE_INFINITY, -0.5])(
    "is off for a malformed difficulty (%o)",
    (value) => {
      expect(miningPlan(value)).toEqual({ kind: "off" });
    },
  );

  it("plans a budget for a difficulty it can attempt", () => {
    const plan = miningPlan(20);
    expect(plan).toMatchObject({ kind: "mine", targetBits: 20 });
    if (plan.kind !== "mine") return;
    expect(plan.budgetMs).toBeGreaterThanOrEqual(MIN_MINING_MS);
    expect(plan.budgetMs).toBeLessThanOrEqual(MAX_MINING_MS);
  });

  // The document deliberately accepts any non-negative integer so a value from a
  // future build round-trips. Attempting one is a guaranteed minute of the user's
  // time spent on a known failure, so it is refused up front and reported instead.
  it("refuses a difficulty beyond what the cap allows", () => {
    const beyond = MAX_ATTEMPTABLE_DIFFICULTY + 1;
    expect(miningPlan(beyond)).toEqual({
      kind: "unreachable",
      targetBits: beyond,
    });
    expect(miningPlan(MAX_ATTEMPTABLE_DIFFICULTY).kind).toBe("mine");
  });
});

describe("miningBudgetMs", () => {
  it("stays inside the floor and the cap", () => {
    for (const bits of [1, 8, 16, 20, 24, 29]) {
      expect(miningBudgetMs(bits)).toBeGreaterThanOrEqual(MIN_MINING_MS);
      expect(miningBudgetMs(bits)).toBeLessThanOrEqual(MAX_MINING_MS);
    }
  });

  // Cost doubles per bit, so a budget that did not grow with difficulty would
  // guarantee a timeout at the settings a user would actually reach for.
  it("never shrinks as difficulty rises", () => {
    let previous = 0;
    for (let bits = 1; bits <= 29; bits += 1) {
      const budget = miningBudgetMs(bits);
      expect(budget).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });

  // The cap is what makes "publish without the work" a bounded wait. Without it a
  // composer at difficulty 28 would be gone for hours.
  it("caps a difficulty that would take longer than the cap", () => {
    expect(miningBudgetMs(29)).toBe(MAX_MINING_MS);
  });
});

describe("POW_CHOICES", () => {
  // A picker offering a value the planner calls unreachable would be a trap: the
  // user chooses it, every note publishes without the work, and nothing they can
  // see explains why.
  it("only offers difficulties this build will attempt", () => {
    for (const bits of POW_CHOICES) {
      expect(miningPlan(bits).kind).not.toBe("unreachable");
    }
  });

  it("offers off", () => {
    expect(POW_CHOICES).toContain(0);
  });
});

describe("unsignedForMining / templateFromMined", () => {
  const template = { kind: 1, content: "hello", tags: [["t", "nostr"]] };

  /*
   * The bug this pair exists to prevent, and the reason it is tested rather than
   * commented: a signer handed a template with no `created_at` stamps its own. That
   * is a different serialisation, so a different id, so the mined nonce buys
   * nothing — and there is no error anywhere, just a note with no proof of work in
   * it and a client that thinks it has some.
   */
  it("pins created_at through mining and back into the template", () => {
    const unsigned = unsignedForMining(template, AUTHOR, 1_700_000_000);
    expect(unsigned.created_at).toBe(1_700_000_000);
    expect(unsigned.pubkey).toBe(AUTHOR);

    const mined = {
      ...unsigned,
      tags: [
        ["t", "nostr"],
        ["nonce", "17", "20"],
      ],
    };
    const toSign = templateFromMined(template, mined);
    expect(toSign.created_at).toBe(1_700_000_000);
    expect(toSign.tags).toContainEqual(["nonce", "17", "20"]);
    expect(toSign.kind).toBe(1);
    expect(toSign.content).toBe("hello");
  });

  // A caller that set its own timestamp (a scheduled or re-signed event) must keep
  // it: overwriting it here would re-date the event, which for a reply reorders a
  // conversation.
  it("keeps a created_at the caller already chose", () => {
    const pinned = { ...template, created_at: 1_600_000_000 };
    expect(unsignedForMining(pinned, AUTHOR, 1_700_000_000).created_at).toBe(
      1_600_000_000,
    );
  });
});

describe("summarisePow", () => {
  it("measures what the signed id actually achieved", () => {
    const summary = summarisePow({
      requested: 8,
      outcome: "mined",
      signedId: idWithZeroBits(9),
    });
    expect(summary).toEqual({ requested: 8, achieved: 9, outcome: "mined" });
  });

  /*
   * The case that makes grading from the id non-negotiable. Between mining and
   * signing sits a signer this app does not control: a NIP-07 extension that
   * ignores the `created_at` we sent, or an account switched in the extension
   * mid-post, both return a valid event with none of the work in it. Trusting the
   * miner's own report here would print "difficulty 20" over an id that has none,
   * which per NIP-13 is exactly the false claim that invalidates the event.
   */
  it("calls mined work lost when it is not in the signed id", () => {
    const summary = summarisePow({
      requested: 20,
      outcome: "mined",
      signedId: "f".repeat(64),
    });
    expect(summary).toEqual({ requested: 20, achieved: 0, outcome: "lost" });
  });

  it("leaves a timeout a timeout", () => {
    expect(
      summarisePow({
        requested: 20,
        outcome: "timeout",
        signedId: idWithZeroBits(3),
      }),
    ).toEqual({ requested: 20, achieved: 3, outcome: "timeout" });
  });
});

describe("describePow", () => {
  it("says nothing when proof of work is off", () => {
    expect(describePow(undefined)).toBeUndefined();
    expect(
      describePow({ requested: 0, achieved: 4, outcome: "mined" }),
    ).toBeUndefined();
  });

  it("reports the difficulty that was reached", () => {
    expect(describePow({ requested: 20, achieved: 21, outcome: "mined" })).toBe(
      "Includes proof of work: difficulty 21.",
    );
  });

  /*
   * The honesty requirement, as a test. Running out of time, being skipped, being
   * unreachable and having no worker are all "the note went out without the work",
   * and every one of them has to say so — a "sent" line that covered for a silent
   * downgrade is the one outcome this feature is not allowed to produce.
   */
  it.each(["timeout", "skipped", "unreachable", "unavailable"] as const)(
    "never lets %s pass for success",
    (outcome) => {
      const message = describePow({ requested: 20, achieved: 0, outcome });
      expect(message).toContain("without proof of work");
    },
  );

  it("explains work that was mined and then lost", () => {
    const message = describePow({
      requested: 20,
      achieved: 0,
      outcome: "lost",
    });
    expect(message).toContain("lost");
    expect(message).toContain("20");
  });
});

describe("labels", () => {
  it("names off as off", () => {
    expect(difficultyChoiceLabel(0)).toBe("Off");
  });

  it("puts the cost on the option", () => {
    expect(difficultyChoiceLabel(16)).toContain("16 bits");
    expect(difficultyChoiceLabel(16)).toMatch(/second|s$|s,/);
  });

  // Promising "about 84s" for a difficulty that stops being attempted at 60 would
  // describe something that cannot happen.
  it("never promises a time past the cap", () => {
    expect(difficultyChoiceLabel(24)).toContain("often not reached");
  });

  // Both halves matter: hashes say something is happening, elapsed-of-budget says
  // how much longer it can last. A spinner alone reads as a hung tab.
  it("shows work done and time left while mining", () => {
    const label = miningLabel({
      targetBits: 20,
      hashes: 1_400_000,
      elapsedMs: 6200,
      budgetMs: 21_000,
    });
    expect(label).toContain("difficulty 20");
    expect(label).toContain("1.4M hashes");
    expect(label).toContain("6s of 21s");
  });
});
