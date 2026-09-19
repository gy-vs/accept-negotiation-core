/**
 * Property-style tests over seeded random inputs.
 *
 * The central guarantee under test: the negotiation result is a pure,
 * deterministic function of (headers, weights, candidates). The ONLY way
 * candidate input order influences the outcome is the documented final
 * tie-break (earliest server-side candidate wins a full tie). Object key
 * insertion order, GC, hash seeds, etc. must have no observable effect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiate,
  DIMENSIONS,
  type CandidateReport,
  type NegotiationResult,
} from '../src/index.js';
import { genHeaders, genVariants, genWeights, mulberry32, shuffled, type GenVariant } from './helpers.js';

const ITERATIONS = 400;

interface Case {
  readonly seed: number;
  readonly headers: ReturnType<typeof genHeaders>;
  readonly weights: ReturnType<typeof genWeights>;
  readonly variants: readonly GenVariant[];
}

function genCase(seed: number): Case {
  const rng = mulberry32(seed);
  return { seed, headers: genHeaders(rng), weights: genWeights(rng), variants: genVariants(rng) };
}

function run(c: Case): NegotiationResult<GenVariant> {
  return negotiate<GenVariant>(c.variants, { headers: c.headers, weights: c.weights });
}

/** Rebuilds the tie-break vectors from the public report (fixed dimension order). */
function tieVectors(
  result: NegotiationResult<GenVariant>,
  candidate: CandidateReport<GenVariant>,
): { spec: number[]; ord: number[] } {
  const spec: number[] = [];
  const ord: number[] = [];
  for (const dim of DIMENSIONS) {
    const ev = candidate.dimensions[dim];
    if (!ev.participated) continue;
    spec.push(...ev.specificity);
    ord.push(ev.rangeIndex ?? result.dimensions[dim].ranges.length);
  }
  return { spec, ord };
}

/* ------------------------------------------------------------------ */

test('P1: repeated runs over identical inputs are byte-identical', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x1000 + i);
    const first = JSON.stringify(run(c));
    const second = JSON.stringify(run(c));
    const third = JSON.stringify(run(c));
    assert.equal(second, first, `seed ${c.seed}: run 2 differs`);
    assert.equal(third, first, `seed ${c.seed}: run 3 differs`);
  }
});

test('P2: object key insertion order of headers/weights is irrelevant', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x2000 + i);
    const rng = mulberry32(0x9000 + i);
    const baseline = JSON.stringify(run(c));

    const reshuffledHeaders = Object.fromEntries(shuffled(rng, Object.entries(c.headers)));
    const reshuffledWeights = Object.fromEntries(shuffled(rng, Object.entries(c.weights)));
    const rerun = negotiate<GenVariant>(c.variants, { headers: reshuffledHeaders, weights: reshuffledWeights });
    assert.equal(JSON.stringify(rerun), baseline, `seed ${c.seed}: key order changed the result`);
  }
});

test('P3: structural invariants of status, winner, elimination and vary', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x3000 + i);
    const r = run(c);
    const ctx = `seed ${c.seed}`;

    assert.ok(r.status === 'ok' || r.status === 'not-negotiable', `${ctx}: generated inputs must be valid`);

    const survivors = r.candidates.filter((x) => !x.eliminated);
    if (survivors.length === 0) {
      assert.equal(r.status, 'not-negotiable', `${ctx}: no survivor must mean not-negotiable`);
      assert.equal(r.winner, null, ctx);
    } else {
      assert.equal(r.status, 'ok', ctx);
      assert.ok(r.winner !== null, ctx);
      const winnerReport = r.candidates[r.winner.index];
      assert.ok(winnerReport !== undefined && !winnerReport.eliminated, `${ctx}: winner must be a survivor`);
      const maxScore = Math.max(...survivors.map((x) => x.score as number));
      assert.equal(r.winner.score, maxScore, `${ctx}: winner must attain the max score`);
    }

    for (const cand of r.candidates) {
      if (cand.eliminated) {
        assert.ok(cand.eliminationReasons.length > 0, `${ctx}: eliminated without reason`);
        assert.equal(cand.score, null, ctx);
      } else {
        assert.deepEqual(cand.eliminationReasons, [], ctx);
        assert.ok(cand.score !== null && cand.score >= 0 && cand.score <= 1, `${ctx}: score range`);
      }
      for (const reason of cand.eliminationReasons) {
        assert.match(reason, /^(mediaType|language|encoding|charset):(no-match|q-zero)$/, ctx);
      }
      for (const dim of DIMENSIONS) {
        const ev = cand.dimensions[dim];
        if (ev.reason === 'q-zero') {
          assert.equal(ev.quality, 0, `${ctx}: q-zero reason requires quality 0`);
          assert.ok(cand.eliminated, `${ctx}: q-zero must eliminate`);
        }
        if (!ev.participated) {
          assert.equal(r.dimensions[dim].state, 'absent', `${ctx}: non-participation only when absent`);
        }
      }
    }

    // Vary is exactly the set of participating dimensions, in fixed order.
    const expectedVary = DIMENSIONS.filter((d) => r.dimensions[d].participated).map(
      (d) => r.dimensions[d].header,
    );
    assert.deepEqual([...r.vary], expectedVary, `${ctx}: vary mismatch`);
    for (const dim of DIMENSIONS) {
      if (r.dimensions[dim].state === 'absent') {
        assert.ok(!r.vary.includes(r.dimensions[dim].header), `${ctx}: absent header in vary`);
        assert.equal(r.dimensions[dim].weight, 0, ctx);
        assert.deepEqual(r.dimensions[dim].ranges, [], ctx);
      }
    }
  }
});

test('P4: implicit identity rule for Accept-Encoding', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x4000 + i);
    const r = run(c);
    const enc = r.dimensions.encoding;
    if (enc.state !== 'present') continue;
    const listsIdentityOrStar = enc.ranges.some((x) => x.value === 'identity' || x.value === '*');
    if (listsIdentityOrStar) continue;
    for (const cand of r.candidates) {
      const coding = cand.variant.encoding?.toLowerCase() ?? 'identity';
      if (coding !== 'identity') continue;
      const ev = cand.dimensions.encoding;
      assert.equal(ev.quality, 1, `seed ${c.seed}: identity must be acceptable by default`);
      assert.equal(ev.rangeIndex, null, `seed ${c.seed}: implicit identity has no range`);
      assert.match(ev.note ?? '', /identity/, `seed ${c.seed}`);
    }
  }
});

test('P5: candidate order only matters via the final server-order tie-break', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x5000 + i);
    const r1 = run(c);
    const rng = mulberry32(0xa000 + i);
    const ctx = `seed ${c.seed}`;

    // Permute the candidates.
    const perm = shuffled(
      rng,
      c.variants.map((_, idx) => idx),
    );
    const variants2 = perm.map((idx) => c.variants[idx] as GenVariant);
    const r2 = negotiate<GenVariant>(variants2, { headers: c.headers, weights: c.weights });

    assert.equal(r2.status, r1.status, `${ctx}: status changed under permutation`);
    assert.deepEqual(r2.vary, r1.vary, `${ctx}: vary changed under permutation`);
    assert.deepEqual(r2.dimensions, r1.dimensions, `${ctx}: dimension reports changed`);

    // Every candidate's report is intrinsic: identical modulo its position.
    for (let j = 0; j < perm.length; j++) {
      const before = r1.candidates[perm[j] as number];
      const after = r2.candidates[j];
      assert.ok(before !== undefined && after !== undefined, ctx);
      assert.equal(after.index, j, ctx);
      const { index: _a, ...restBefore } = before;
      const { index: _b, ...restAfter } = after;
      assert.deepEqual(restAfter, restBefore, `${ctx}: candidate report depends on position`);
    }

    if (r1.winner === null) {
      assert.equal(r2.winner, null, ctx);
      continue;
    }

    // Tie group: survivors indistinguishable from the winner on score and
    // both tie-break vectors.
    const winnerReport = r1.candidates[r1.winner.index] as CandidateReport<GenVariant>;
    const wv = tieVectors(r1, winnerReport);
    const tieGroup = new Set<number>();
    for (const cand of r1.candidates) {
      if (cand.eliminated || cand.score !== winnerReport.score) continue;
      const v = tieVectors(r1, cand);
      if (v.spec.length === wv.spec.length && v.spec.every((x, k) => x === wv.spec[k]) &&
          v.ord.length === wv.ord.length && v.ord.every((x, k) => x === wv.ord[k])) {
        tieGroup.add(cand.index);
      }
    }

    // After permutation the winner must be the tie-group member that landed
    // on the smallest new position — nothing else may change the outcome.
    let expected = -1;
    for (let j = 0; j < perm.length; j++) {
      if (tieGroup.has(perm[j] as number)) {
        expected = j;
        break;
      }
    }
    assert.ok(r2.winner !== null, ctx);
    assert.equal(r2.winner.index, expected, `${ctx}: winner is not the earliest tie-group member`);
    assert.equal(r2.winner.score, r1.winner.score, `${ctx}: winner score changed under permutation`);
  }
});

test('P6: exclusion monotonicity — zeroing the winner\'s matched ranges unseats it', () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const c = genCase(0x6000 + i);
    const r1 = run(c);
    if (r1.winner === null) continue;
    const winner = r1.candidates[r1.winner.index] as CandidateReport<GenVariant>;

    // Rewrite the headers so every range the winner matched gets q=0.
    // The previous winner must then be eliminated (or the request invalid
    // never happens: we only patch q values, keeping syntax intact).
    const headers: Record<string, string | undefined> = { ...c.headers };
    let patched = false;
    const dimToHeader: Record<string, string> = {
      mediaType: 'accept',
      language: 'acceptLanguage',
      encoding: 'acceptEncoding',
      charset: 'acceptCharset',
    };
    for (const dim of DIMENSIONS) {
      const ev = winner.dimensions[dim];
      if (!ev.participated || ev.rangeRaw === null) continue;
      const key = dimToHeader[dim] as string;
      const original = headers[key];
      if (original === undefined) continue;
      // Append a q=0 override for the exact matched range value. Because the
      // most specific range wins and ties break to the earliest entry, put
      // the override first with identical range text.
      const rangeText = ev.rangeRaw.replace(/;q=[^;]*$/, '');
      headers[key] = `${rangeText};q=0, ${original}`;
      patched = true;
    }
    if (!patched) continue;

    const r2 = negotiate<GenVariant>(c.variants, { headers, weights: c.weights });
    const ctx = `seed ${c.seed}`;
    assert.equal(r2.status === 'invalid-request', false, `${ctx}: patch must keep headers valid`);
    const again = r2.candidates[r1.winner.index];
    assert.ok(again !== undefined, ctx);
    assert.ok(again.eliminated, `${ctx}: winner survived q=0 override of all its matched ranges`);
  }
});
