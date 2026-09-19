import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NegotiationSyntaxError,
  computeVary,
  negotiate,
  parseAccept,
  type Candidate,
  type CandidateReport,
  type NegotiationRequest,
  type Weights,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) so every failure is reproducible from its seed.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  pick<T>(items: readonly T[]): T;
  int(n: number): number;
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  const rand = mulberry32(seed);
  return {
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(rand() * items.length)]!;
    },
    int(n: number): number {
      return Math.floor(rand() * n);
    },
    chance(p: number): boolean {
      return rand() < p;
    },
  };
}

// ---------------------------------------------------------------------------
// Random input generators (only well-formed inputs; parser strictness is
// covered by the table-driven tests).
// ---------------------------------------------------------------------------

const TYPES = ['text', 'application', 'image'] as const;
const SUBTYPES = ['html', 'json', 'plain', 'xml'] as const;
const PARAM_POOL = [
  ['level', '1'],
  ['level', '2'],
  ['charset', 'utf-8'],
  ['version', '2'],
] as const;
const LANGS = ['en', 'en-US', 'en-GB', 'zh', 'zh-Hant', 'fr', 'de'] as const;
const ENCODINGS = ['gzip', 'br', 'deflate', 'identity'] as const;
const CHARSETS = ['utf-8', 'iso-8859-1', 'utf-16'] as const;
const QS = [undefined, '0', '0.25', '0.5', '0.8', '1'] as const;
const WEIGHT_VALUES = [0, 0.5, 1, 2] as const;

function randomParams(rng: Rng, max: number): string {
  let out = '';
  const used = new Set<string>();
  const n = rng.int(max + 1);
  for (let i = 0; i < n; i++) {
    const [name, value] = rng.pick(PARAM_POOL);
    if (used.has(name)) continue;
    used.add(name);
    out += `;${name}=${value}`;
  }
  return out;
}

function randomMediaType(rng: Rng): string {
  return `${rng.pick(TYPES)}/${rng.pick(SUBTYPES)}${randomParams(rng, 2)}`;
}

function randomMediaRange(rng: Rng): string {
  const kind = rng.int(10);
  let range: string;
  if (kind < 6) range = `${rng.pick(TYPES)}/${rng.pick(SUBTYPES)}`;
  else if (kind < 8) range = `${rng.pick(TYPES)}/*`;
  else range = '*/*';
  range += randomParams(rng, 1);
  const q = rng.pick(QS);
  if (q !== undefined) range += `;q=${q}`;
  return range;
}

function randomWeightedList(rng: Rng, values: readonly string[], allowStar: boolean): string {
  const n = 1 + rng.int(3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    let part = allowStar && rng.chance(0.15) ? '*' : rng.pick(values);
    const q = rng.pick(QS);
    if (q !== undefined) part += `;q=${q}`;
    parts.push(part);
  }
  return parts.join(', ');
}

function randomRequest(rng: Rng): NegotiationRequest {
  return {
    accept: rng.chance(0.2) ? null : randomAcceptValue(rng),
    acceptLanguage: rng.chance(0.2) ? null : randomWeightedList(rng, LANGS, true),
    acceptEncoding: rng.chance(0.2) ? null : randomWeightedList(rng, ENCODINGS, true),
    acceptCharset: rng.chance(0.2) ? null : randomWeightedList(rng, CHARSETS, true),
  };
}

function randomAcceptValue(rng: Rng): string {
  const n = 1 + rng.int(3);
  return Array.from({ length: n }, () => randomMediaRange(rng)).join(', ');
}

type TestCandidate = Candidate<{ id: number }>;

function randomCandidate(rng: Rng, id: number): TestCandidate {
  const candidate: TestCandidate = { mediaType: randomMediaType(rng), data: { id } };
  if (rng.chance(0.6)) candidate.language = rng.pick(LANGS);
  if (rng.chance(0.5)) candidate.encoding = rng.pick(ENCODINGS);
  if (rng.chance(0.5)) candidate.charset = rng.pick(CHARSETS);
  return candidate;
}

function randomWeights(rng: Rng): Weights {
  const weights: Weights = {
    media: rng.pick(WEIGHT_VALUES),
    language: rng.pick(WEIGHT_VALUES),
    encoding: rng.pick(WEIGHT_VALUES),
    charset: rng.pick(WEIGHT_VALUES),
  };
  if (!weights.media && !weights.language && !weights.encoding && !weights.charset) {
    weights.media = 1;
  }
  return weights;
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key used for tie-breaking comparisons: everything except the server index.
// ---------------------------------------------------------------------------

type ReportKey = Array<number>;

function keyOf(report: CandidateReport<unknown>): ReportKey {
  return [
    report.score,
    report.totalSpecificity,
    ...report.dimensions.map((d) => d.matchedRangeIndex ?? -1),
  ];
}

function keyEqual(a: ReportKey, b: ReportKey): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Report contents that must be invariant under candidate permutation. */
function normalizeReport(report: CandidateReport<{ id: number }>) {
  return {
    eliminated: report.eliminated,
    eliminationReasons: report.eliminationReasons,
    score: report.score,
    totalSpecificity: report.totalSpecificity,
    dimensions: report.dimensions,
  };
}

function reportsById(result: { reports: CandidateReport<{ id: number }>[] }) {
  return new Map(result.reports.map((r) => [r.candidate.data!.id, normalizeReport(r)]));
}

// ---------------------------------------------------------------------------
// Property 1: no nondeterminism beyond the candidate input order.
// ---------------------------------------------------------------------------

test('property: negotiation is deterministic up to the candidate input order', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = makeRng(seed);
    const count = 1 + rng.int(6);
    const candidates = Array.from({ length: count }, (_, i) => randomCandidate(rng, i));
    const request = randomRequest(rng);
    const weights = randomWeights(rng);
    const context = `seed=${seed}`;

    const base = negotiate(candidates, request, { weights });

    // Pure determinism: the same input yields a deeply equal result.
    assert.deepEqual(negotiate(candidates, request, { weights }), base, context);

    for (let round = 0; round < 3; round++) {
      const shuffleRng = makeRng(seed * 1000 + round + 1);
      const permuted = shuffled(candidates, shuffleRng);
      const result = negotiate(permuted, request, { weights });

      assert.equal(result.ok, base.ok, context);
      // Every candidate's evaluation is independent of its position.
      assert.deepEqual(reportsById(result), reportsById(base), context);

      if (base.ok) {
        assert.ok(result.ok, context);
        // The winner's tie-break key is permutation-invariant...
        assert.ok(keyEqual(keyOf(result.selected), keyOf(base.selected)), context);
        // ...and the winner is the earliest (in input order) among the
        // candidates tied on that key.
        const winnerKey = keyOf(result.selected);
        const tied = result.reports.filter((r) => !r.eliminated && keyEqual(keyOf(r), winnerKey));
        assert.equal(
          result.selected.serverIndex,
          Math.min(...tied.map((r) => r.serverIndex)),
          context,
        );
        // The winner must be one of the candidates tied for first in the base run.
        const baseTiedIds = new Set(
          base.reports
            .filter((r) => !r.eliminated && keyEqual(keyOf(r), keyOf(base.selected)))
            .map((r) => r.candidate.data!.id),
        );
        assert.ok(baseTiedIds.has(result.selected.candidate.data!.id), context);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Property 2: structural invariants of the result.
// ---------------------------------------------------------------------------

test('property: result invariants (qualities, scores, elimination, vary)', () => {
  const CANONICAL = ['Accept', 'Accept-Language', 'Accept-Encoding', 'Accept-Charset'];
  for (let seed = 1000; seed <= 1300; seed++) {
    const rng = makeRng(seed);
    const count = 1 + rng.int(6);
    const candidates = Array.from({ length: count }, (_, i) => randomCandidate(rng, i));
    const request = randomRequest(rng);
    const weights = randomWeights(rng);
    const context = `seed=${seed}`;

    const result = negotiate(candidates, request, { weights });

    for (const report of result.reports) {
      for (const dimension of report.dimensions) {
        assert.ok(dimension.quality >= 0 && dimension.quality <= 1, context);
        assert.ok(dimension.specificity >= 0, context);
        if (!dimension.headerPresent) assert.equal(dimension.state, 'header-missing', context);
      }
      // eliminated <=> at least one dimension has quality 0
      assert.equal(
        report.eliminated,
        report.dimensions.some((d) => d.quality === 0),
        context,
      );
      assert.equal(report.eliminationReasons.length > 0, report.eliminated, context);
      assert.ok(report.score >= 0 && report.score <= 1, context);
      if (report.eliminated) assert.equal(report.score, 0, context);
    }

    if (result.ok) {
      // The selected candidate is never excluded in any dimension.
      assert.ok(result.selected.dimensions.every((d) => d.quality > 0), context);
      assert.ok(result.selected.score > 0, context);
    } else if (result.failure === 'all-candidates-excluded') {
      assert.ok(result.reports.every((r) => r.eliminated), context);
      const counts = result.eliminatedCounts;
      for (const name of ['media', 'language', 'encoding', 'charset'] as const) {
        const expected: number = result.reports.filter(
          (r) => r.dimensions.find((d) => d.dimension === name)!.quality === 0,
        ).length;
        assert.equal(counts[name], expected, context);
      }
    }

    // Vary: subset of the canonical set, consistent with computeVary, and
    // missing headers never appear.
    assert.deepEqual(result.vary, computeVary(candidates, request), context);
    assert.ok(result.vary.every((v) => CANONICAL.includes(v)), context);
    if (request.accept == null) assert.ok(!result.vary.includes('Accept'), context);
    else assert.ok(result.vary.includes('Accept'), context);
    if (request.acceptEncoding == null) assert.ok(!result.vary.includes('Accept-Encoding'), context);
    else assert.ok(result.vary.includes('Accept-Encoding'), context);
    const anyLang = candidates.some((c) => c.language !== undefined);
    assert.equal(result.vary.includes('Accept-Language'), request.acceptLanguage != null && anyLang, context);
    const anyCharset = candidates.some((c) => c.charset !== undefined);
    assert.equal(result.vary.includes('Accept-Charset'), request.acceptCharset != null && anyCharset, context);
  }
});

// ---------------------------------------------------------------------------
// Property 3: missing headers vs explicit stars are never conflated.
// ---------------------------------------------------------------------------

test('property: missing headers and explicit stars are distinct states', () => {
  for (let seed = 2000; seed <= 2100; seed++) {
    const rng = makeRng(seed);
    const count = 1 + rng.int(5);
    const candidates = Array.from({ length: count }, (_, i) => randomCandidate(rng, i));
    const weights = randomWeights(rng);
    const context = `seed=${seed}`;

    const missing = negotiate(candidates, {}, { weights });
    assert.ok(missing.ok, context);
    for (const report of missing.reports) {
      assert.ok(
        report.dimensions.every((d) => d.state === 'header-missing' && d.matchedRange === null),
        context,
      );
      assert.ok(!report.eliminated, context);
    }
    assert.deepEqual(missing.vary, [], context);

    const starred = negotiate(
      candidates,
      { accept: '*/*', acceptLanguage: '*', acceptEncoding: '*', acceptCharset: '*' },
      { weights },
    );
    assert.ok(starred.ok, context);
    for (const report of starred.reports) {
      assert.ok(
        report.dimensions.every((d) => d.state === 'matched' || d.state === 'not-applicable'),
        context,
      );
    }
    assert.ok(starred.vary.includes('Accept'), context);
    assert.ok(starred.vary.includes('Accept-Encoding'), context);
  }
});

// ---------------------------------------------------------------------------
// Property 4: the parser only ever throws NegotiationSyntaxError (never
// crashes) on arbitrary input.
// ---------------------------------------------------------------------------

test('property: parser robustness on random byte soup', () => {
  const alphabet = 'abcXYZ019;/,*="q. \t\\-';
  for (let seed = 3000; seed <= 3300; seed++) {
    const rng = makeRng(seed);
    const length = rng.int(40);
    let value = '';
    for (let i = 0; i < length; i++) {
      value += alphabet[rng.int(alphabet.length)];
    }
    try {
      parseAccept(value);
    } catch (error) {
      assert.ok(error instanceof NegotiationSyntaxError, `seed=${seed} value=${JSON.stringify(value)}`);
    }
  }
});
