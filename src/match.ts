/**
 * Per-dimension matching of one server variant against the parsed client
 * ranges of one header.
 *
 * Every matcher returns the *best* matching client range, where "best" is:
 *   1. highest specificity (per-dimension vector, compared element-wise),
 *   2. then earliest client order (lowest `index`).
 * The winning range's q is the quality of the variant in that dimension.
 * A returned quality of 0 is a definitive exclusion (q=0), distinct from
 * `null` which means "no range matched at all".
 */

import type { MediaRange, MediaTypeValue, TokenRange } from './parse.js';

export interface DimensionMatch {
  /** Milli-quality 0..1000 (exact integer). */
  readonly quality: number;
  /** Index of the matched client range, or null for implicit matches. */
  readonly rangeIndex: number | null;
  /** Specificity vector; compared lexicographically across candidates. */
  readonly specificity: readonly number[];
  /** Optional explanation note (e.g. implicit identity). */
  readonly note?: string;
}

/* ------------------------------------------------------------------ */
/* Media type                                                          */
/* ------------------------------------------------------------------ */

/**
 * Specificity vector for media types: [typeSpecificity, parameterCount]
 *   typeSpecificity: 0 = full wildcard, 1 = subtype wildcard, 2 = exact.
 *   parameterCount:  number of media type parameters on the client range
 *                    (all of them must be present on the variant).
 */
export function matchMediaType(
  ranges: readonly MediaRange[],
  candidate: MediaTypeValue | null,
): DimensionMatch | null {
  let best: { q: number; index: number; spec: readonly [number, number] } | null = null;

  for (const r of ranges) {
    if (candidate === null) {
      // A variant without a media type can only be matched by a bare `*/*`.
      if (r.type !== '*' || r.params.length !== 0) continue;
    } else {
      if (r.type !== '*' && r.type !== candidate.type) continue;
      if (r.subtype !== '*' && r.subtype !== candidate.subtype) continue;
      let paramsOk = true;
      for (const [name, value] of r.params) {
        const found = candidate.params.find(([cn]) => cn === name);
        if (found === undefined || found[1] !== value) {
          paramsOk = false;
          break;
        }
      }
      if (!paramsOk) continue;
    }

    const spec: readonly [number, number] =
      r.type === '*' ? [0, r.params.length] : r.subtype === '*' ? [1, r.params.length] : [2, r.params.length];

    if (
      best === null ||
      spec[0] > best.spec[0] ||
      (spec[0] === best.spec[0] && (spec[1] > best.spec[1] || (spec[1] === best.spec[1] && r.index < best.index)))
    ) {
      best = { q: r.q, index: r.index, spec };
    }
  }

  return best === null ? null : { quality: best.q, rangeIndex: best.index, specificity: best.spec };
}

/* ------------------------------------------------------------------ */
/* Language (RFC 4647 basic filtering)                                 */
/* ------------------------------------------------------------------ */

/**
 * A range matches a tag if it equals the tag or is a prefix of it on a
 * subtag boundary (`en` matches `en-US`; `en-US` does not match `en`).
 * Specificity: [number of subtags in the range]; `*` is [0].
 */
export function matchLanguage(ranges: readonly TokenRange[], tag: string | null): DimensionMatch | null {
  let best: { q: number; index: number; spec: number } | null = null;

  for (const r of ranges) {
    let spec: number;
    if (r.value === '*') {
      spec = 0;
    } else {
      if (tag === null) continue;
      if (tag !== r.value && !tag.startsWith(r.value + '-')) continue;
      spec = r.value.split('-').length;
    }
    if (best === null || spec > best.spec || (spec === best.spec && r.index < best.index)) {
      best = { q: r.q, index: r.index, spec };
    }
  }

  return best === null ? null : { quality: best.q, rangeIndex: best.index, specificity: [best.spec] };
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Exact coding match beats `*`. Per RFC 9110 §12.5.3, a representation with
 * no content coding ("identity") is acceptable by default when the header is
 * present but lists neither `identity` nor `*`; it is excluded by
 * `identity;q=0` or by `*;q=0` (unless a more specific identity entry exists).
 */
export function matchEncoding(ranges: readonly TokenRange[], coding: string): DimensionMatch | null {
  let exact: TokenRange | null = null;
  let star: TokenRange | null = null;

  for (const r of ranges) {
    if (r.value === coding) {
      if (exact === null || r.index < exact.index) exact = r;
    } else if (r.value === '*') {
      if (star === null || r.index < star.index) star = r;
    }
  }

  if (exact !== null) return { quality: exact.q, rangeIndex: exact.index, specificity: [1] };
  if (star !== null) return { quality: star.q, rangeIndex: star.index, specificity: [0] };
  if (coding === 'identity') {
    return {
      quality: 1000,
      rangeIndex: null,
      specificity: [0],
      note: 'identity acceptable by default (not listed in Accept-Encoding)',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Charset                                                             */
/* ------------------------------------------------------------------ */

/** Exact charset match beats `*`. No implicit defaults (RFC 9110 §12.5.2). */
export function matchCharset(ranges: readonly TokenRange[], charset: string | null): DimensionMatch | null {
  let exact: TokenRange | null = null;
  let star: TokenRange | null = null;

  for (const r of ranges) {
    if (charset !== null && r.value === charset) {
      if (exact === null || r.index < exact.index) exact = r;
    } else if (r.value === '*') {
      if (star === null || r.index < star.index) star = r;
    }
  }

  if (exact !== null) return { quality: exact.q, rangeIndex: exact.index, specificity: [1] };
  if (star !== null) return { quality: star.q, rangeIndex: star.index, specificity: [0] };
  return null;
}
