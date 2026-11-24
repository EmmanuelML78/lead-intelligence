import assert from "node:assert/strict";
import test from "node:test";
import { compareAssignableLeads, type PriorityLead } from "../src/lib/assignment/eligibility";

const T1 = new Date("2026-08-01T00:00:00.000Z");
const T2 = new Date("2026-09-01T00:00:00.000Z");

function lead(
  leadId: string,
  totalScore: number | null,
  registeredAt: Date | null = T1,
  registeredAtAmbiguous = false
): PriorityLead {
  return {
    leadId,
    registeredAt,
    registeredAtAmbiguous,
    currentScore: totalScore === null ? null : { totalScore }
  };
}

function ids(leads: readonly PriorityLead[]): string[] {
  return leads.map((row) => row.leadId);
}

/** Small deterministic PRNG so shuffles are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Every combination of score (missing, non-finite, tied, distinct), date
 * (two trusted values, missing, ambiguous, invalid) and id that the
 * comparator has to rank.
 */
function population(): PriorityLead[] {
  const scores: Array<number | null> = [null, Number.NaN, 40, 50, 50.5];
  const dates: Array<{ at: Date | null; ambiguous: boolean }> = [
    { at: T1, ambiguous: false },
    { at: T2, ambiguous: false },
    { at: null, ambiguous: false },
    { at: T1, ambiguous: true },
    { at: new Date(Number.NaN), ambiguous: false }
  ];
  const leads: PriorityLead[] = [];
  let n = 0;
  for (const totalScore of scores) {
    for (const date of dates) {
      for (const prefix of ["LD-B", "LD-A"]) {
        n += 1;
        leads.push(lead(`${prefix}-${String(n).padStart(3, "0")}`, totalScore, date.at, date.ambiguous));
      }
    }
  }
  return leads;
}

test("comparator reproduces no cycle for a known date, an unknown date and a later known date", () => {
  // With equal scores the old rule compared dates only when both were known
  // and fell back to leadId otherwise, which made these three a cycle:
  // early < late (dates), late < unknown (ids), unknown < early (ids).
  const early = lead("LD-3", 50, T1);
  const unknown = lead("LD-2", 50, null);
  const late = lead("LD-1", 50, T2);

  assert.ok(compareAssignableLeads(early, late) < 0, "earlier trusted date goes first");
  assert.ok(compareAssignableLeads(late, unknown) < 0, "a trusted date goes before an unknown one");
  assert.ok(compareAssignableLeads(early, unknown) < 0, "transitivity: early must also precede unknown");

  for (const order of [
    [early, unknown, late],
    [unknown, late, early],
    [late, early, unknown],
    [late, unknown, early]
  ]) {
    assert.deepEqual(ids([...order].sort(compareAssignableLeads)), ["LD-3", "LD-1", "LD-2"]);
  }
});

test("comparator is reflexive and antisymmetric for every pair", () => {
  const leads = population();
  for (const a of leads) {
    assert.equal(compareAssignableLeads(a, a), 0);
    for (const b of leads) {
      const forward = compareAssignableLeads(a, b);
      const backward = compareAssignableLeads(b, a);
      assert.ok(!Number.isNaN(forward), `NaN comparing ${a.leadId} with ${b.leadId}`);
      assert.equal(Math.sign(forward) + Math.sign(backward), 0, `${a.leadId} vs ${b.leadId}`);
      if (a !== b) assert.notEqual(forward, 0, `distinct leads ${a.leadId} and ${b.leadId} must not tie`);
    }
  }
});

test("comparator is transitive for every triple", () => {
  const leads = population();
  for (const a of leads) {
    for (const b of leads) {
      if (compareAssignableLeads(a, b) >= 0) continue;
      for (const c of leads) {
        if (compareAssignableLeads(b, c) >= 0) continue;
        assert.ok(
          compareAssignableLeads(a, c) < 0,
          `${a.leadId} < ${b.leadId} and ${b.leadId} < ${c.leadId}, but not ${a.leadId} < ${c.leadId}`
        );
      }
    }
  }
});

test("sorting any permutation of the same leads yields the same order", () => {
  const leads = population();
  const expected = ids([...leads].sort(compareAssignableLeads));
  const random = mulberry32(20260914);
  for (let round = 0; round < 200; round += 1) {
    assert.deepEqual(ids(shuffled(leads, random).sort(compareAssignableLeads)), expected);
  }
  assert.deepEqual(ids([...leads].reverse().sort(compareAssignableLeads)), expected);
});

test("comparator is deterministic: repeated calls and repeated sorts agree", () => {
  const leads = population();
  const first = ids([...leads].sort(compareAssignableLeads));
  for (let round = 0; round < 5; round += 1) {
    assert.deepEqual(ids([...leads].sort(compareAssignableLeads)), first);
  }
  const a = leads[3]!;
  const b = leads[17]!;
  assert.equal(compareAssignableLeads(a, b), compareAssignableLeads(a, b));
});

test("score has priority over every other criterion", () => {
  const highScoreUnknownDateLateId = lead("LD-Z", 80, null);
  const lowScoreEarlyDateFirstId = lead("LD-A", 79.9, T1);
  assert.ok(compareAssignableLeads(highScoreUnknownDateLateId, lowScoreEarlyDateFirstId) < 0);
});

test("score ties are broken by trusted registration date, then by leadId", () => {
  const sorted = [
    lead("LD-4", 50, T2),
    lead("LD-3", 50, T1),
    lead("LD-2", 50, T2),
    lead("LD-1", 50, T1)
  ].sort(compareAssignableLeads);
  assert.deepEqual(ids(sorted), ["LD-1", "LD-3", "LD-2", "LD-4"]);
});

test("unknown dates (missing, ambiguous or invalid) rank after trusted dates and tie-break by leadId", () => {
  const sorted = [
    lead("LD-6", 50, new Date(Number.NaN)),
    lead("LD-5", 50, T1, true),
    lead("LD-4", 50, null),
    lead("LD-3", 50, T2),
    lead("LD-2", 60, null),
    lead("LD-1", 50, T1)
  ].sort(compareAssignableLeads);
  // LD-2 wins on score despite its unknown date; then trusted dates ASC;
  // then the three unknown dates by leadId, never by their untrusted value.
  assert.deepEqual(ids(sorted), ["LD-2", "LD-1", "LD-3", "LD-4", "LD-5", "LD-6"]);
});

test("leads without a usable score rank last and stay totally ordered", () => {
  const sorted = [
    lead("LD-4", Number.NaN, T1),
    lead("LD-3", null, T2),
    lead("LD-2", null, T1),
    lead("LD-1", 0, null)
  ].sort(compareAssignableLeads);
  assert.deepEqual(ids(sorted), ["LD-1", "LD-2", "LD-4", "LD-3"]);
});

test("leadId tie-break uses code-unit order, independent of the runtime locale", () => {
  const sorted = [lead("ld-a", 50), lead("LD-b", 50), lead("LD-B", 50), lead("LD-10", 50), lead("LD-9", 50)].sort(
    compareAssignableLeads
  );
  assert.deepEqual(ids(sorted), ["LD-10", "LD-9", "LD-B", "LD-b", "ld-a"]);
});
