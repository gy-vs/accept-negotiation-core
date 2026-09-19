/**
 * Content negotiation core: combines per-dimension matches into a weighted
 * score and picks a winner deterministically.
 *
 * Decision procedure (all comparisons are explicit, never object-key order):
 *   1. A dimension participates iff its header is present and well-formed.
 *      A missing header is NOT the same as an explicit `*`: a missing header
 *      means the dimension does not constrain the choice at all.
 *   2. A candidate is eliminated if any participating dimension yields
 *      quality 0 (q=0 exclusion) or no matching range.
 *   3. Survivors are ranked by:
 *        a. weighted quality score  score = Σ w_d·q_d / Σ w_d   (desc),
 *        b. specificity vector, dimensions in fixed order
 *           [mediaType, language, encoding, charset]            (desc),
 *        c. matched client-range positions, same fixed order     (asc),
 *        d. server-side candidate order                          (asc).
 *   4. If no candidate survives, the result is `not-negotiable`.
 */

import {
  parseAccept,
  parseAcceptCharset,
  parseAcceptEncoding,
  parseAcceptLanguage,
  parseMediaTypeValue,
  normalizeLanguageTag,
  normalizeToken,
  ParseError,
  type MediaRange,
  type MediaTypeValue,
  type TokenRange,
} from './parse.js';
import {
  matchCharset,
  matchEncoding,
  matchLanguage,
  matchMediaType,
  type DimensionMatch,
} from './match.js';

/* ------------------------------------------------------------------ */
/* Public input types                                                  */
/* ------------------------------------------------------------------ */

export type DimensionName = 'mediaType' | 'language' | 'encoding' | 'charset';

/** Fixed dimension precedence used for tie-breaking. Never iterated from objects. */
export const DIMENSIONS: readonly DimensionName[] = ['mediaType', 'language', 'encoding', 'charset'];

const DIMENSION_HEADERS: Readonly<Record<DimensionName, string>> = {
  mediaType: 'Accept',
  language: 'Accept-Language',
  encoding: 'Accept-Encoding',
  charset: 'Accept-Charset',
};

/** A server-side candidate representation. Extra payload fields are allowed. */
export interface Variant {
  readonly mediaType?: string;
  readonly language?: string;
  /** Content coding; omit or use "identity" for an unencoded representation. */
  readonly encoding?: string;
  readonly charset?: string;
}

export interface RequestHeaders {
  readonly accept?: string;
  readonly acceptLanguage?: string;
  readonly acceptEncoding?: string;
  readonly acceptCharset?: string;
}

/** Server-configured per-dimension weights. Missing keys default to 1. */
export interface WeightConfig {
  readonly mediaType?: number;
  readonly language?: number;
  readonly encoding?: number;
  readonly charset?: number;
}

export interface NegotiateOptions {
  readonly headers: RequestHeaders;
  readonly weights?: WeightConfig;
}

/* ------------------------------------------------------------------ */
/* Public result types                                                 */
/* ------------------------------------------------------------------ */

export type DimensionState = 'absent' | 'present' | 'invalid';

export interface RangeReport {
  readonly index: number;
  readonly raw: string;
  /** Normalized form, e.g. "text/html;level=1" or "en-us". */
  readonly value: string;
  /** 0..1 */
  readonly q: number;
}

export interface DimensionReport {
  readonly header: string;
  readonly state: DimensionState;
  /** Parse error message when state === 'invalid'. */
  readonly error?: string;
  /** Effective weight used in scoring (0 when the dimension did not participate). */
  readonly weight: number;
  /** True when this dimension actually constrained the selection (drives Vary). */
  readonly participated: boolean;
  /** Parsed client ranges, in original order. Empty unless state === 'present'. */
  readonly ranges: readonly RangeReport[];
}

export type EliminationReason = 'no-match' | 'q-zero';

export interface DimensionEval {
  /** False when the header was absent: the dimension did not constrain anything. */
  readonly participated: boolean;
  readonly matched: boolean;
  /** Index into DimensionReport.ranges; null for implicit matches / non-matches. */
  readonly rangeIndex: number | null;
  /** Original text of the matched client range. */
  readonly rangeRaw: string | null;
  /** 0..1 (1 when the dimension did not participate). */
  readonly quality: number;
  /** Specificity vector used for tie-breaking. Empty when not participating. */
  readonly specificity: readonly number[];
  readonly note?: string;
  /** Present when this dimension eliminated the candidate. */
  readonly reason?: EliminationReason;
}

export interface CandidateReport<T extends Variant> {
  readonly index: number;
  readonly variant: T;
  readonly eliminated: boolean;
  /** e.g. ["mediaType:q-zero", "language:no-match"] */
  readonly eliminationReasons: readonly string[];
  /** Weighted score in [0,1]; null when eliminated. */
  readonly score: number | null;
  readonly dimensions: Readonly<Record<DimensionName, DimensionEval>>;
}

export type NegotiationStatus = 'ok' | 'not-negotiable' | 'invalid-request';

export interface NegotiationResult<T extends Variant> {
  readonly status: NegotiationStatus;
  readonly winner: { readonly index: number; readonly variant: T; readonly score: number } | null;
  readonly dimensions: Readonly<Record<DimensionName, DimensionReport>>;
  readonly candidates: readonly CandidateReport<T>[];
  /** Canonical header names that actually influenced the selection. */
  readonly vary: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

type ParsedDimension =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly error: string }
  | { readonly status: 'present'; readonly ranges: readonly (MediaRange | TokenRange)[] };

function parseDimension(
  headerValue: string | undefined,
  parser: (input: string) => { readonly ok: true; readonly value: readonly (MediaRange | TokenRange)[] } | { readonly ok: false; readonly error: string },
): ParsedDimension {
  if (headerValue === undefined) return { status: 'absent' };
  const parsed = parser(headerValue);
  if (!parsed.ok) return { status: 'invalid', error: parsed.error };
  return { status: 'present', ranges: parsed.value };
}

interface NormalizedVariant {
  readonly mediaType: MediaTypeValue | null;
  readonly language: string | null;
  readonly encoding: string; // always defined; 'identity' when absent
  readonly charset: string | null;
}

function normalizeVariant(variant: Variant, index: number): NormalizedVariant {
  try {
    return {
      mediaType: variant.mediaType !== undefined ? parseMediaTypeValue(variant.mediaType) : null,
      language: variant.language !== undefined ? normalizeLanguageTag(variant.language) : null,
      encoding: variant.encoding !== undefined ? normalizeToken(variant.encoding, 'encoding') : 'identity',
      charset: variant.charset !== undefined ? normalizeToken(variant.charset, 'charset') : null,
    };
  } catch (e) {
    if (e instanceof ParseError) {
      throw new TypeError(`invalid variant at index ${index}: ${e.message}`);
    }
    throw e;
  }
}

function resolveWeights(config: WeightConfig | undefined): Record<DimensionName, number> {
  const resolved: Record<DimensionName, number> = { mediaType: 1, language: 1, encoding: 1, charset: 1 };
  if (config !== undefined) {
    for (const dim of DIMENSIONS) {
      const value = config[dim];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`weight for dimension "${dim}" must be a finite number >= 0, got ${String(value)}`);
      }
      resolved[dim] = value;
    }
  }
  return resolved;
}

function matchDimension(
  dim: DimensionName,
  ranges: readonly (MediaRange | TokenRange)[],
  variant: NormalizedVariant,
): DimensionMatch | null {
  switch (dim) {
    case 'mediaType':
      return matchMediaType(ranges as readonly MediaRange[], variant.mediaType);
    case 'language':
      return matchLanguage(ranges as readonly TokenRange[], variant.language);
    case 'encoding':
      return matchEncoding(ranges as readonly TokenRange[], variant.encoding);
    case 'charset':
      return matchCharset(ranges as readonly TokenRange[], variant.charset);
  }
}

/**
 * A header whose only entry is a bare wildcard with q=1 does not actually
 * constrain the selection, so it must not appear in Vary.
 */
function isPureWildcard(dim: DimensionName, ranges: readonly (MediaRange | TokenRange)[]): boolean {
  if (ranges.length !== 1) return false;
  const only = ranges[0];
  if (only === undefined || only.q !== 1000) return false;
  if (dim === 'mediaType') {
    const m = only as MediaRange;
    return m.type === '*' && m.params.length === 0 && m.extensions.length === 0;
  }
  return (only as TokenRange).value === '*';
}

function rangeReport(dim: DimensionName, ranges: readonly (MediaRange | TokenRange)[]): readonly RangeReport[] {
  return ranges.map((r, index) => {
    let value: string;
    if (dim === 'mediaType') {
      const m = r as MediaRange;
      value = `${m.type}/${m.subtype}` + m.params.map(([n, v]) => `;${n}=${v}`).join('');
    } else {
      value = (r as TokenRange).value;
    }
    return { index, raw: r.raw, value, q: r.q / 1000 };
  });
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

export function negotiate<T extends Variant>(
  variants: readonly T[],
  options: NegotiateOptions,
): NegotiationResult<T> {
  const weights = resolveWeights(options.weights);
  const headers = options.headers;

  const states: Record<DimensionName, ParsedDimension> = {
    mediaType: parseDimension(headers.accept, parseAccept),
    language: parseDimension(headers.acceptLanguage, parseAcceptLanguage),
    encoding: parseDimension(headers.acceptEncoding, parseAcceptEncoding),
    charset: parseDimension(headers.acceptCharset, parseAcceptCharset),
  };

  // Effective weights: dimensions that do not participate contribute nothing.
  // If the participating weights sum to zero, fall back to equal weights so
  // that the score stays well-defined.
  const effectiveWeights: Record<DimensionName, number> = { ...weights };
  {
    let sum = 0;
    for (const dim of DIMENSIONS) {
      if (states[dim].status === 'present') sum += effectiveWeights[dim];
    }
    const anyPresent = DIMENSIONS.some((dim) => states[dim].status === 'present');
    if (anyPresent && sum === 0) {
      for (const dim of DIMENSIONS) {
        if (states[dim].status === 'present') effectiveWeights[dim] = 1;
      }
    }
  }

  const dimensionReports = {} as Record<DimensionName, DimensionReport>;
  for (const dim of DIMENSIONS) {
    const state = states[dim];
    const participated = state.status === 'present' && !isPureWildcard(dim, state.ranges);
    dimensionReports[dim] = {
      header: DIMENSION_HEADERS[dim],
      state: state.status,
      ...(state.status === 'invalid' ? { error: state.error } : {}),
      weight: state.status === 'present' ? effectiveWeights[dim] : 0,
      participated,
      ranges: state.status === 'present' ? rangeReport(dim, state.ranges) : [],
    };
  }

  const invalid = DIMENSIONS.filter((dim) => states[dim].status === 'invalid');
  if (invalid.length > 0) {
    return {
      status: 'invalid-request',
      winner: null,
      dimensions: dimensionReports,
      candidates: [],
      vary: [],
    };
  }

  const participating = DIMENSIONS.filter((dim) => states[dim].status === 'present');
  const weightSum = participating.reduce((acc, dim) => acc + effectiveWeights[dim], 0);

  const normalized = variants.map((v, i) => normalizeVariant(v, i));

  interface Ranked {
    readonly report: CandidateReport<T>;
    readonly specFlat: readonly number[];
    readonly ordFlat: readonly number[];
  }

  const ranked: Ranked[] = normalized.map((nv, index) => {
    const evals = {} as Record<DimensionName, DimensionEval>;
    const eliminationReasons: string[] = [];
    const specFlat: number[] = [];
    const ordFlat: number[] = [];
    let scoreMilli = 0;

    for (const dim of DIMENSIONS) {
      const state = states[dim];
      if (state.status !== 'present') {
        evals[dim] = {
          participated: false,
          matched: true,
          rangeIndex: null,
          rangeRaw: null,
          quality: 1,
          specificity: [],
          note: 'dimension not negotiated (header absent)',
        };
        continue;
      }

      const match = matchDimension(dim, state.ranges, nv);
      if (match === null) {
        eliminationReasons.push(`${dim}:no-match`);
        evals[dim] = {
          participated: true,
          matched: false,
          rangeIndex: null,
          rangeRaw: null,
          quality: 0,
          specificity: [],
          reason: 'no-match',
        };
        continue;
      }

      const rangeRaw = match.rangeIndex !== null ? (state.ranges[match.rangeIndex]?.raw ?? null) : null;
      evals[dim] = {
        participated: true,
        matched: true,
        rangeIndex: match.rangeIndex,
        rangeRaw,
        quality: match.quality / 1000,
        specificity: match.specificity,
        ...(match.note !== undefined ? { note: match.note } : {}),
        ...(match.quality === 0 ? { reason: 'q-zero' as const } : {}),
      };

      if (match.quality === 0) {
        eliminationReasons.push(`${dim}:q-zero`);
      } else {
        scoreMilli += effectiveWeights[dim] * match.quality;
        specFlat.push(...match.specificity);
        // Implicit matches (no client range) sort after all listed ranges.
        ordFlat.push(match.rangeIndex ?? state.ranges.length);
      }
    }

    const eliminated = eliminationReasons.length > 0;
    const score = eliminated ? null : participating.length === 0 ? 1 : scoreMilli / (weightSum * 1000);

    return {
      report: {
        index,
        variant: variants[index] as T,
        eliminated,
        eliminationReasons,
        score,
        dimensions: evals,
      },
      specFlat,
      ordFlat,
    };
  });

  const compare = (a: Ranked, b: Ranked): number => {
    const sa = a.report.score as number;
    const sb = b.report.score as number;
    if (sa !== sb) return sb - sa;
    const n = Math.min(a.specFlat.length, b.specFlat.length);
    for (let i = 0; i < n; i++) {
      const d = (b.specFlat[i] as number) - (a.specFlat[i] as number);
      if (d !== 0) return d;
    }
    const m = Math.min(a.ordFlat.length, b.ordFlat.length);
    for (let i = 0; i < m; i++) {
      const d = (a.ordFlat[i] as number) - (b.ordFlat[i] as number);
      if (d !== 0) return d;
    }
    return a.report.index - b.report.index;
  };

  let best: Ranked | null = null;
  for (const candidate of ranked) {
    if (candidate.report.eliminated) continue;
    if (best === null || compare(candidate, best) < 0) best = candidate;
  }

  const vary = DIMENSIONS.filter((dim) => dimensionReports[dim].participated).map(
    (dim) => DIMENSION_HEADERS[dim],
  );

  if (best === null) {
    return {
      status: 'not-negotiable',
      winner: null,
      dimensions: dimensionReports,
      candidates: ranked.map((r) => r.report),
      vary,
    };
  }

  return {
    status: 'ok',
    winner: { index: best.report.index, variant: best.report.variant, score: best.report.score as number },
    dimensions: dimensionReports,
    candidates: ranked.map((r) => r.report),
    vary,
  };
}

/* ------------------------------------------------------------------ */
/* Vary                                                                */
/* ------------------------------------------------------------------ */

/**
 * Computes the set of request header names that would participate in
 * negotiation for the given headers, i.e. the value of a correct `Vary`
 * response header. Absent headers and headers that are only a bare `*`
 * wildcard with q=1 are excluded; malformed headers are included
 * conservatively (a cache cannot predict how they will be treated).
 */
export function varyFor(headers: RequestHeaders): readonly string[] {
  const checks: ReadonlyArray<readonly [DimensionName, string | undefined]> = [
    ['mediaType', headers.accept],
    ['language', headers.acceptLanguage],
    ['encoding', headers.acceptEncoding],
    ['charset', headers.acceptCharset],
  ];
  const parsers: Record<DimensionName, (input: string) => { readonly ok: boolean; readonly value?: readonly (MediaRange | TokenRange)[]; readonly error?: string }> = {
    mediaType: parseAccept,
    language: parseAcceptLanguage,
    encoding: parseAcceptEncoding,
    charset: parseAcceptCharset,
  };

  const out: string[] = [];
  for (const [dim, value] of checks) {
    if (value === undefined) continue;
    const parsed = parsers[dim](value);
    if (!parsed.ok) {
      out.push(DIMENSION_HEADERS[dim]);
      continue;
    }
    const ranges = parsed.value as readonly (MediaRange | TokenRange)[];
    if (!isPureWildcard(dim, ranges)) out.push(DIMENSION_HEADERS[dim]);
  }
  return out;
}
