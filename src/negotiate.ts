/**
 * The negotiation entry point.
 *
 * Selection procedure (fully deterministic; never relies on object key
 * enumeration order):
 *
 * 1. Each candidate is evaluated against each of the four dimensions,
 *    producing a quality in [0, 1] per dimension. A quality of 0 in ANY
 *    dimension eliminates the candidate (q=0 means "not acceptable").
 * 2. Surviving candidates get a score: the weighted average of the four
 *    dimension qualities, using the server-configured dimension weights.
 * 3. Survivors are ordered by:
 *      a. higher score,
 *      b. higher total specificity (sum of the four dimension specificities),
 *      c. earlier matched client range, compared dimension by dimension in
 *         the canonical order media, language, encoding, charset (a
 *         dimension with no matched range sorts after any explicit index),
 *      d. lower server index (the candidate's position in the input list).
 *    The first candidate in that order wins.
 *
 * If no candidate survives, the result is `ok: false` with
 * `failure: 'all-candidates-excluded'` and per-dimension elimination counts.
 */
import { CandidateError, ConfigurationError, NegotiationSyntaxError } from './errors.js';
import { evalCharset, evalEncoding, evalLanguage, evalMedia, type PreparedCandidate } from './match.js';
import {
  LANGUAGE_TAG_RE,
  parseAccept,
  parseAcceptCharset,
  parseAcceptEncoding,
  parseAcceptLanguage,
  parseMediaType,
  type CharsetRange,
  type EncodingRange,
  type LanguageRange,
  type MediaRange,
} from './parse.js';
import { isToken } from './syntax.js';
import type {
  Candidate,
  CandidateReport,
  DimensionName,
  NegotiationOptions,
  NegotiationRequest,
  NegotiationResult,
  Weights,
} from './types.js';
import { computeVary } from './vary.js';

const DIMENSION_NAMES = ['media', 'language', 'encoding', 'charset'] as const;

interface ParsedHeaders {
  readonly accept: readonly MediaRange[] | null;
  readonly acceptLanguage: readonly LanguageRange[] | null;
  readonly acceptEncoding: readonly EncodingRange[] | null;
  readonly acceptCharset: readonly CharsetRange[] | null;
}

function resolveWeights(weights?: Weights): Record<DimensionName, number> {
  const resolved: Record<DimensionName, number> = {
    media: weights?.media ?? 1,
    language: weights?.language ?? 1,
    encoding: weights?.encoding ?? 1,
    charset: weights?.charset ?? 1,
  };
  let total = 0;
  for (const name of DIMENSION_NAMES) {
    const w = resolved[name];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new ConfigurationError(`weight for dimension "${name}" must be a finite number >= 0, got ${String(w)}`);
    }
    total += w;
  }
  if (total === 0) {
    throw new ConfigurationError('at least one dimension weight must be greater than 0');
  }
  return resolved;
}

function prepareCandidate<T>(input: Candidate<T>, serverIndex: number): PreparedCandidate<T> {
  const subject = `candidates[${serverIndex}]`;
  if (input === null || typeof input !== 'object') {
    throw new CandidateError(`${subject} must be an object`);
  }
  if (typeof input.mediaType !== 'string' || input.mediaType.length === 0) {
    throw new CandidateError(`${subject}.mediaType must be a non-empty string`);
  }
  const mediaType = parseMediaType(input.mediaType, `${subject}.mediaType`);

  let languageSubtags: readonly string[] | null = null;
  if (input.language !== undefined) {
    if (typeof input.language !== 'string' || !LANGUAGE_TAG_RE.test(input.language)) {
      throw new NegotiationSyntaxError(`${subject}.language`, `invalid language tag ${JSON.stringify(input.language)}`);
    }
    languageSubtags = input.language.toLowerCase().split('-');
  }

  let encoding = 'identity';
  if (input.encoding !== undefined) {
    if (typeof input.encoding !== 'string' || input.encoding === '*' || !isToken(input.encoding)) {
      throw new NegotiationSyntaxError(`${subject}.encoding`, `invalid content coding ${JSON.stringify(input.encoding)}`);
    }
    encoding = input.encoding.toLowerCase();
  }

  let charset: string | null = null;
  if (input.charset !== undefined) {
    if (typeof input.charset !== 'string' || input.charset === '*' || !isToken(input.charset)) {
      throw new NegotiationSyntaxError(`${subject}.charset`, `invalid charset ${JSON.stringify(input.charset)}`);
    }
    charset = input.charset.toLowerCase();
  }

  return { input, serverIndex, mediaType, languageSubtags, encoding, charset };
}

function parseHeaders(request: NegotiationRequest): ParsedHeaders {
  return {
    accept: request.accept === null || request.accept === undefined ? null : parseAccept(request.accept),
    acceptLanguage:
      request.acceptLanguage === null || request.acceptLanguage === undefined
        ? null
        : parseAcceptLanguage(request.acceptLanguage),
    acceptEncoding:
      request.acceptEncoding === null || request.acceptEncoding === undefined
        ? null
        : parseAcceptEncoding(request.acceptEncoding),
    acceptCharset:
      request.acceptCharset === null || request.acceptCharset === undefined
        ? null
        : parseAcceptCharset(request.acceptCharset),
  };
}

function evaluateCandidate<T>(
  pc: PreparedCandidate<T>,
  headers: ParsedHeaders,
  weights: Record<DimensionName, number>,
): CandidateReport<T> {
  const dimensions: CandidateReport<T>['dimensions'] = [
    evalMedia(pc, headers.accept),
    evalLanguage(pc, headers.acceptLanguage),
    evalEncoding(pc, headers.acceptEncoding),
    evalCharset(pc, headers.acceptCharset),
  ];
  const eliminated = dimensions.some((d) => d.quality === 0);
  const eliminationReasons = dimensions
    .filter((d) => d.quality === 0)
    .map((d) => `[${d.dimension}] ${d.reason}`);
  const weightSum = weights.media + weights.language + weights.encoding + weights.charset;
  const score = eliminated
    ? 0
    : (weights.media * dimensions[0].quality +
        weights.language * dimensions[1].quality +
        weights.encoding * dimensions[2].quality +
        weights.charset * dimensions[3].quality) /
      weightSum;
  const totalSpecificity = dimensions.reduce((sum, d) => sum + d.specificity, 0);
  return {
    candidate: pc.input,
    serverIndex: pc.serverIndex,
    eliminated,
    eliminationReasons,
    score,
    totalSpecificity,
    dimensions,
  };
}

/**
 * Total order over surviving candidate reports: score, then specificity,
 * then client range order per dimension, then server index.
 */
function compareReports<T>(a: CandidateReport<T>, b: CandidateReport<T>): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.totalSpecificity !== b.totalSpecificity) return b.totalSpecificity - a.totalSpecificity;
  for (let i = 0; i < 4; i++) {
    const ai = a.dimensions[i]!.matchedRangeIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.dimensions[i]!.matchedRangeIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
  }
  return a.serverIndex - b.serverIndex;
}

/**
 * Negotiate the best candidate for the given request headers.
 *
 * @param candidates server-side candidate representations (order is the
 *                   final tie-break)
 * @param request    the four Accept-* header values; null/undefined = missing
 * @param options    optional dimension weights
 */
export function negotiate<T>(
  candidates: readonly Candidate<T>[],
  request: NegotiationRequest = {},
  options: NegotiationOptions = {},
): NegotiationResult<T> {
  if (!Array.isArray(candidates)) {
    throw new ConfigurationError('candidates must be an array');
  }
  const weights = resolveWeights(options.weights);
  const prepared: PreparedCandidate<T>[] = candidates.map((candidate, index) => prepareCandidate(candidate, index));
  const headers = parseHeaders(request);
  const vary = computeVary(candidates as readonly Candidate<unknown>[], request);

  if (prepared.length === 0) {
    return { ok: false, failure: 'no-candidates', reports: [], vary };
  }

  const reports: CandidateReport<T>[] = prepared.map((pc) => evaluateCandidate(pc, headers, weights));
  const survivors = reports.filter((report) => !report.eliminated);
  if (survivors.length === 0) {
    const eliminatedCounts: Record<DimensionName, number> = { media: 0, language: 0, encoding: 0, charset: 0 };
    for (const report of reports) {
      for (const dimension of report.dimensions) {
        if (dimension.quality === 0) eliminatedCounts[dimension.dimension]++;
      }
    }
    return { ok: false, failure: 'all-candidates-excluded', reports, vary, eliminatedCounts };
  }

  survivors.sort(compareReports<T>);
  return { ok: true, selected: survivors[0]!, reports, vary };
}
