/**
 * Vary header computation: which request headers actually participated in
 * the selection. A header participates when it was present in the request
 * AND the dimension could discriminate between the candidates:
 *
 * - Accept / Accept-Encoding: every candidate has a media type and an
 *   effective content coding (identity by default), so these dimensions
 *   always participate when the header is present.
 * - Accept-Language / Accept-Charset: participate only when at least one
 *   candidate declares a language / charset; otherwise the header cannot
 *   influence the outcome.
 *
 * The result uses canonical casing and a fixed order, so it is deterministic
 * and safe to join with ", " for a Vary response header.
 */
import type { Candidate, NegotiationRequest } from './types.js';

const CANONICAL_ORDER = ['Accept', 'Accept-Language', 'Accept-Encoding', 'Accept-Charset'] as const;

export function computeVary(candidates: readonly Candidate<unknown>[], request: NegotiationRequest): string[] {
  const anyLanguage = candidates.some(
    (c) => c !== null && typeof c === 'object' && c.language !== undefined,
  );
  const anyCharset = candidates.some(
    (c) => c !== null && typeof c === 'object' && c.charset !== undefined,
  );
  const participating = new Set<string>();
  if (request.accept !== null && request.accept !== undefined) participating.add('Accept');
  if (request.acceptLanguage !== null && request.acceptLanguage !== undefined && anyLanguage) {
    participating.add('Accept-Language');
  }
  if (request.acceptEncoding !== null && request.acceptEncoding !== undefined) {
    participating.add('Accept-Encoding');
  }
  if (request.acceptCharset !== null && request.acceptCharset !== undefined && anyCharset) {
    participating.add('Accept-Charset');
  }
  return CANONICAL_ORDER.filter((name) => participating.has(name));
}
