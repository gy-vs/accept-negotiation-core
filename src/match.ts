/**
 * Per-dimension matching. Each evaluator produces a DimensionReport for one
 * candidate, computing:
 * - the quality q in [0, 1] (0 = excluded),
 * - the specificity of the matched range,
 * - which client range determined the result (raw text + index),
 * - a human-readable reason.
 *
 * A missing request header (`ranges === null`) is a distinct state from an
 * explicit "*" and always yields quality 1 with no matched range.
 */
import type { CharsetRange, EncodingRange, LanguageRange, MediaRange, MediaType } from './parse.js';
import type { Candidate, DimensionReport } from './types.js';

/** A candidate after validation/parsing, ready for matching. */
export interface PreparedCandidate<T> {
  readonly input: Candidate<T>;
  readonly serverIndex: number;
  readonly mediaType: MediaType;
  /** Lowercased language subtags, or null when the candidate declares no language. */
  readonly languageSubtags: readonly string[] | null;
  /** Lowercased content coding; "identity" when the candidate declares none. */
  readonly encoding: string;
  /** Lowercased charset, or null when the candidate declares none. */
  readonly charset: string | null;
}

function dimensionReport(
  dimension: DimensionReport['dimension'],
  headerPresent: boolean,
  state: DimensionReport['state'],
  quality: number,
  specificity: number,
  matchedRange: string | null,
  matchedRangeIndex: number | null,
  reason: string,
): DimensionReport {
  return { dimension, headerPresent, state, quality, specificity, matchedRange, matchedRangeIndex, reason };
}

/** Media dimension (Accept). */
export function evalMedia<T>(pc: PreparedCandidate<T>, ranges: readonly MediaRange[] | null): DimensionReport {
  if (ranges === null) {
    return dimensionReport(
      'media',
      false,
      'header-missing',
      1,
      0,
      null,
      null,
      'Accept header is missing; any media type is acceptable (q=1)',
    );
  }
  let best: { range: MediaRange; exactness: number; specificity: number } | null = null;
  for (const range of ranges) {
    const exactness = range.type === '*' ? 0 : range.subtype === '*' ? 1 : 2;
    if (exactness >= 1 && range.type !== pc.mediaType.type) continue;
    if (exactness === 2 && range.subtype !== pc.mediaType.subtype) continue;
    let paramsMatch = true;
    for (const [name, value] of range.params) {
      if (pc.mediaType.params.get(name) !== value) {
        paramsMatch = false;
        break;
      }
    }
    if (!paramsMatch) continue;
    const specificity = exactness + range.params.length;
    // Ranges are visited in client order, so a strict improvement keeps the
    // earliest range among equally specific ones.
    if (best === null || exactness > best.exactness || (exactness === best.exactness && specificity > best.specificity)) {
      best = { range, exactness, specificity };
    }
  }
  if (best === null) {
    return dimensionReport(
      'media',
      true,
      'excluded',
      0,
      0,
      null,
      null,
      ranges.length === 0
        ? 'Accept header is empty; no media type is acceptable'
        : `no media range matches media type "${pc.input.mediaType}"`,
    );
  }
  const { range } = best;
  if (range.q === 0) {
    return dimensionReport(
      'media',
      true,
      'excluded',
      0,
      best.specificity,
      range.raw,
      range.index,
      `excluded by media range "${range.raw}" (q=0)`,
    );
  }
  return dimensionReport(
    'media',
    true,
    'matched',
    range.q,
    best.specificity,
    range.raw,
    range.index,
    `matched media range "${range.raw}" with q=${range.q}`,
  );
}

/** Basic language filtering: the range must be a subtag-prefix of the tag. */
function languageMatches(rangeSubtags: readonly string[], tagSubtags: readonly string[]): boolean {
  if (rangeSubtags.length > tagSubtags.length) return false;
  for (let i = 0; i < rangeSubtags.length; i++) {
    if (rangeSubtags[i] !== tagSubtags[i]) return false;
  }
  return true;
}

/** Language dimension (Accept-Language). */
export function evalLanguage<T>(pc: PreparedCandidate<T>, ranges: readonly LanguageRange[] | null): DimensionReport {
  if (ranges === null) {
    return dimensionReport(
      'language',
      false,
      'header-missing',
      1,
      0,
      null,
      null,
      'Accept-Language header is missing; any language is acceptable (q=1)',
    );
  }
  if (pc.languageSubtags === null) {
    return dimensionReport(
      'language',
      true,
      'not-applicable',
      1,
      0,
      null,
      null,
      'candidate declares no language; the language dimension is neutral (q=1)',
    );
  }
  let best: { range: LanguageRange; specificity: number } | null = null;
  for (const range of ranges) {
    let specificity: number;
    if (range.subtags === null) {
      specificity = 0;
    } else if (languageMatches(range.subtags, pc.languageSubtags)) {
      specificity = range.subtags.length;
    } else {
      continue;
    }
    if (best === null || specificity > best.specificity) {
      best = { range, specificity };
    }
  }
  if (best === null) {
    return dimensionReport(
      'language',
      true,
      'excluded',
      0,
      0,
      null,
      null,
      ranges.length === 0
        ? 'Accept-Language header is empty; no language is acceptable'
        : `no language range matches language "${pc.input.language ?? ''}"`,
    );
  }
  const { range } = best;
  if (range.q === 0) {
    return dimensionReport(
      'language',
      true,
      'excluded',
      0,
      best.specificity,
      range.raw,
      range.index,
      `excluded by language range "${range.raw}" (q=0)`,
    );
  }
  return dimensionReport(
    'language',
    true,
    'matched',
    range.q,
    best.specificity,
    range.raw,
    range.index,
    `matched language range "${range.raw}" with q=${range.q}`,
  );
}

/** Encoding dimension (Accept-Encoding), with RFC 9110 identity semantics. */
export function evalEncoding<T>(pc: PreparedCandidate<T>, ranges: readonly EncodingRange[] | null): DimensionReport {
  if (ranges === null) {
    return dimensionReport(
      'encoding',
      false,
      'header-missing',
      1,
      0,
      null,
      null,
      'Accept-Encoding header is missing; any content coding is acceptable (q=1)',
    );
  }
  const coding = pc.encoding;
  const explicit = ranges.find((range) => range.coding === coding);
  const star = ranges.find((range) => range.coding === null);
  const fromRange = (range: EncodingRange, specificity: number, via: string): DimensionReport => {
    if (range.q === 0) {
      return dimensionReport(
        'encoding',
        true,
        'excluded',
        0,
        specificity,
        range.raw,
        range.index,
        `excluded by coding range "${range.raw}" (q=0)`,
      );
    }
    return dimensionReport(
      'encoding',
      true,
      'matched',
      range.q,
      specificity,
      range.raw,
      range.index,
      `matched coding range "${range.raw}" with q=${range.q}${via}`,
    );
  };
  if (coding === 'identity') {
    // RFC 9110 §12.5.3: a representation without content coding is acceptable
    // by default unless excluded via "identity;q=0" or "*;q=0" without a more
    // specific identity entry.
    if (explicit !== undefined) return fromRange(explicit, 1, '');
    if (star !== undefined) return fromRange(star, 0, ' (identity via "*")');
    return dimensionReport(
      'encoding',
      true,
      'matched',
      1,
      0,
      null,
      null,
      'identity coding is acceptable by default (no explicit "identity" or "*" entry)',
    );
  }
  if (explicit !== undefined) return fromRange(explicit, 1, '');
  if (star !== undefined) return fromRange(star, 0, '');
  return dimensionReport(
    'encoding',
    true,
    'excluded',
    0,
    0,
    null,
    null,
    `content coding "${coding}" is not listed and no "*" entry is present`,
  );
}

/** Charset dimension (Accept-Charset). */
export function evalCharset<T>(pc: PreparedCandidate<T>, ranges: readonly CharsetRange[] | null): DimensionReport {
  if (ranges === null) {
    return dimensionReport(
      'charset',
      false,
      'header-missing',
      1,
      0,
      null,
      null,
      'Accept-Charset header is missing; any charset is acceptable (q=1)',
    );
  }
  if (pc.charset === null) {
    return dimensionReport(
      'charset',
      true,
      'not-applicable',
      1,
      0,
      null,
      null,
      'candidate declares no charset; the charset dimension is neutral (q=1)',
    );
  }
  const charset = pc.charset;
  const explicit = ranges.find((range) => range.charset === charset);
  const star = ranges.find((range) => range.charset === null);
  const selected = explicit ?? star;
  if (selected === undefined) {
    return dimensionReport(
      'charset',
      true,
      'excluded',
      0,
      0,
      null,
      null,
      `charset "${charset}" is not listed and no "*" entry is present`,
    );
  }
  const specificity = explicit !== undefined ? 1 : 0;
  if (selected.q === 0) {
    return dimensionReport(
      'charset',
      true,
      'excluded',
      0,
      specificity,
      selected.raw,
      selected.index,
      `excluded by charset range "${selected.raw}" (q=0)`,
    );
  }
  return dimensionReport(
    'charset',
    true,
    'matched',
    selected.q,
    specificity,
    selected.raw,
    selected.index,
    `matched charset range "${selected.raw}" with q=${selected.q}`,
  );
}
