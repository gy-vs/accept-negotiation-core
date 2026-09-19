/**
 * Public types for the negotiation library.
 */

/** The four negotiation dimensions, in the library's canonical evaluation order. */
export type DimensionName = 'media' | 'language' | 'encoding' | 'charset';

/**
 * Per-dimension outcome state.
 *
 * - `header-missing`: the request header was absent (NOT the same as an
 *   explicit `*`); the dimension imposes no constraint, quality is 1.
 * - `not-applicable`: the header was present but the candidate declares no
 *   value for this dimension (only possible for language and charset);
 *   the candidate is treated as neutral, quality is 1.
 * - `matched`: a client range (possibly `*`) matched with quality > 0.
 * - `excluded`: the dimension excluded the candidate (best match had q=0,
 *   or no range matched and the dimension has no acceptable default).
 */
export type DimensionState = 'header-missing' | 'not-applicable' | 'matched' | 'excluded';

/**
 * A server-side candidate representation.
 *
 * - `mediaType` is required and must be a concrete media type
 *   (e.g. `"text/html;level=1"`), wildcards are not allowed.
 * - `language` is an optional BCP-47-like language tag (e.g. `"en-US"`).
 * - `encoding` is an optional content coding token; absence means `identity`.
 * - `charset` is an optional charset token.
 * - `data` is an opaque payload carried through to the reports so callers
 *   can attach their own representation handles.
 */
export interface Candidate<T = unknown> {
  mediaType: string;
  language?: string;
  encoding?: string;
  charset?: string;
  data?: T;
}

/**
 * The request headers relevant to negotiation. A header that is `null` or
 * `undefined` is treated as MISSING (distinct from an explicit `*`).
 * An empty string is a present-but-empty header and follows the strict
 * per-header semantics (see README).
 */
export interface NegotiationRequest {
  accept?: string | null;
  acceptLanguage?: string | null;
  acceptEncoding?: string | null;
  acceptCharset?: string | null;
}

/**
 * Server-configured dimension weights used to combine per-dimension
 * qualities into a single score. Each weight must be a finite number >= 0
 * and at least one weight must be > 0. Defaults to 1 for every dimension.
 *
 * Note: weights only affect scoring. A dimension whose best match is q=0
 * eliminates the candidate regardless of that dimension's weight.
 */
export interface Weights {
  media?: number;
  language?: number;
  encoding?: number;
  charset?: number;
}

export interface NegotiationOptions {
  weights?: Weights;
}

/** Explanation of how one dimension treated one candidate. */
export interface DimensionReport {
  dimension: DimensionName;
  /** Whether the corresponding request header was present. */
  headerPresent: boolean;
  state: DimensionState;
  /** The quality contributed by this dimension, in [0, 1]. 0 means excluded. */
  quality: number;
  /**
   * Specificity of the matched range (media: exactness 0/1/2 plus matched
   * parameter count; language: number of subtags; encoding/charset: 1 for
   * an explicit entry, 0 for `*`/default). 0 when nothing matched.
   */
  specificity: number;
  /** The raw client range text that determined the quality, if any. */
  matchedRange: string | null;
  /** The 0-based position of the matched range in the client header, if any. */
  matchedRangeIndex: number | null;
  /** Human-readable explanation, e.g. `matched media range "text/*" with q=0.5`. */
  reason: string;
}

/** Full negotiation report for one candidate. */
export interface CandidateReport<T = unknown> {
  candidate: Candidate<T>;
  /** The candidate's index in the server-provided candidate list. */
  serverIndex: number;
  /** True when at least one dimension assigned quality 0. */
  eliminated: boolean;
  /** One entry per excluding dimension, e.g. `[media] excluded by media range "text/html;q=0" (q=0)`. */
  eliminationReasons: string[];
  /**
   * Weighted average of dimension qualities in [0, 1]; 0 when eliminated.
   * Computed as sum(weight_d * quality_d) / sum(weight_d) over all four
   * dimensions (missing headers contribute quality 1).
   */
  score: number;
  /** Sum of the four dimension specificities. */
  totalSpecificity: number;
  /** Per-dimension reports in canonical order: media, language, encoding, charset. */
  dimensions: [DimensionReport, DimensionReport, DimensionReport, DimensionReport];
}

export interface NegotiationSuccess<T = unknown> {
  ok: true;
  /** The winning candidate report. */
  selected: CandidateReport<T>;
  /** Reports for every candidate, in the original server-provided order. */
  reports: CandidateReport<T>[];
  /** Canonical request header names that participated in selection, for the Vary header. */
  vary: string[];
}

export type NegotiationFailure<T = unknown> =
  | {
      ok: false;
      failure: 'no-candidates';
      reports: [];
      vary: string[];
    }
  | {
      ok: false;
      failure: 'all-candidates-excluded';
      reports: CandidateReport<T>[];
      vary: string[];
      /** How many candidates each dimension excluded (a candidate may count in several). */
      eliminatedCounts: Record<DimensionName, number>;
    };

export type NegotiationResult<T = unknown> = NegotiationSuccess<T> | NegotiationFailure<T>;
