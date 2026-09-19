/**
 * Strict parsers for the four Accept-* request headers and for candidate
 * media types. All parsers preserve the original element order (each range
 * carries its 0-based `index`) and keep the original element text in `raw`.
 *
 * Normalization (for comparison only; `raw` is untouched):
 * - type/subtype, parameter names, language subtags, codings and charsets
 *   are lowercased,
 * - media type parameter VALUES are lowercased (they are compared
 *   case-insensitively, matching e.g. the charset parameter's semantics).
 */
import { NegotiationSyntaxError } from './errors.js';
import {
  isToken,
  parseParameter,
  parseWeightSegment,
  segmentName,
  splitHeaderList,
  splitSegments,
} from './syntax.js';

export interface MediaRange {
  readonly type: string; // lowercased, may be "*"
  readonly subtype: string; // lowercased, may be "*"
  /** Media type parameters (before q), as ordered [name, value] pairs; both lowercased. */
  readonly params: ReadonlyArray<readonly [string, string]>;
  /** Accept extensions (parameters after q), as ordered [name, value] pairs. */
  readonly extensions: ReadonlyArray<readonly [string, string]>;
  readonly q: number;
  readonly raw: string;
  readonly index: number;
}

export interface LanguageRange {
  /** Lowercased subtags, or null for "*". */
  readonly subtags: readonly string[] | null;
  readonly q: number;
  readonly raw: string;
  readonly index: number;
}

export interface EncodingRange {
  /** Lowercased coding, or null for "*". */
  readonly coding: string | null;
  readonly q: number;
  readonly raw: string;
  readonly index: number;
}

export interface CharsetRange {
  /** Lowercased charset, or null for "*". */
  readonly charset: string | null;
  readonly q: number;
  readonly raw: string;
  readonly index: number;
}

/** A parsed concrete media type (candidate side). */
export interface MediaType {
  readonly type: string;
  readonly subtype: string;
  /** Parameter name -> value, both lowercased. */
  readonly params: ReadonlyMap<string, string>;
}

function parseTypeSubtype(
  subject: string,
  part: string,
  allowWildcards: boolean,
): { type: string; subtype: string } {
  const slash = part.indexOf('/');
  if (slash <= 0 || slash === part.length - 1 || part.indexOf('/', slash + 1) !== -1) {
    throw new NegotiationSyntaxError(subject, `expected "type/subtype", got "${part}"`);
  }
  const type = part.slice(0, slash).toLowerCase();
  const subtype = part.slice(slash + 1).toLowerCase();
  if (type === '*') {
    if (!allowWildcards) {
      throw new NegotiationSyntaxError(subject, 'wildcard type is not allowed here');
    }
    if (subtype !== '*') {
      throw new NegotiationSyntaxError(subject, `wildcard type requires a wildcard subtype, got "${part}"`);
    }
  } else if (!isToken(type)) {
    throw new NegotiationSyntaxError(subject, `invalid type in "${part}"`);
  }
  if (subtype === '*') {
    if (!allowWildcards) {
      throw new NegotiationSyntaxError(subject, 'wildcard subtype is not allowed here');
    }
  } else if (!isToken(subtype)) {
    throw new NegotiationSyntaxError(subject, `invalid subtype in "${part}"`);
  }
  return { type, subtype };
}

/**
 * Parse an Accept header value into media ranges, preserving order.
 * An empty value yields an empty list (see negotiate() for its semantics).
 */
export function parseAccept(value: string): MediaRange[] {
  const subject = 'Accept';
  return splitHeaderList(subject, value).map((item, index) => {
    const segments = splitSegments(subject, item);
    const { type, subtype } = parseTypeSubtype(subject, segments[0]!, true);
    const params: Array<readonly [string, string]> = [];
    const extensions: Array<readonly [string, string]> = [];
    const seenNames = new Set<string>();
    let q = 1;
    let seenQ = false;
    for (const segment of segments.slice(1)) {
      if (segmentName(segment) === 'q') {
        if (seenQ) {
          throw new NegotiationSyntaxError(subject, `duplicate q parameter in "${item}"`);
        }
        seenQ = true;
        q = parseWeightSegment(subject, segment);
        continue;
      }
      const parameter = parseParameter(subject, segment);
      if (seenNames.has(parameter.name)) {
        throw new NegotiationSyntaxError(subject, `duplicate parameter "${parameter.name}" in "${item}"`);
      }
      seenNames.add(parameter.name);
      const entry = [parameter.name, parameter.value.toLowerCase()] as const;
      if (seenQ) {
        extensions.push(entry);
      } else {
        params.push(entry);
      }
    }
    return { type, subtype, params, extensions, q, raw: item, index };
  });
}

/**
 * language-range = ( 1*8ALPHA *( "-" 1*8alphanum ) ) / "*"
 * The same grammar (without "*") validates candidate language tags.
 */
export const LANGUAGE_TAG_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Parse the parameter segments of a language/encoding/charset list element.
 * Only a single q weight is allowed there (strict; no extensions).
 */
function parseWeightOnly(subject: string, item: string, segments: readonly string[]): number {
  let q = 1;
  let seenQ = false;
  for (const segment of segments) {
    if (segmentName(segment) !== 'q') {
      throw new NegotiationSyntaxError(subject, `unsupported parameter in "${item}" (only q is allowed here)`);
    }
    if (seenQ) {
      throw new NegotiationSyntaxError(subject, `duplicate q parameter in "${item}"`);
    }
    seenQ = true;
    q = parseWeightSegment(subject, segment);
  }
  return q;
}

/** Parse an Accept-Language header value, preserving order. */
export function parseAcceptLanguage(value: string): LanguageRange[] {
  const subject = 'Accept-Language';
  return splitHeaderList(subject, value).map((item, index) => {
    const segments = splitSegments(subject, item);
    const range = segments[0]!;
    let subtags: readonly string[] | null;
    if (range === '*') {
      subtags = null;
    } else {
      if (!LANGUAGE_TAG_RE.test(range)) {
        throw new NegotiationSyntaxError(subject, `invalid language range "${range}"`);
      }
      subtags = range.toLowerCase().split('-');
    }
    const q = parseWeightOnly(subject, item, segments.slice(1));
    return { subtags, q, raw: item, index };
  });
}

/** Parse an Accept-Encoding header value, preserving order. */
export function parseAcceptEncoding(value: string): EncodingRange[] {
  const subject = 'Accept-Encoding';
  return splitHeaderList(subject, value).map((item, index) => {
    const segments = splitSegments(subject, item);
    const token = segments[0]!;
    let coding: string | null;
    if (token === '*') {
      coding = null;
    } else {
      if (!isToken(token)) {
        throw new NegotiationSyntaxError(subject, `invalid content coding "${token}"`);
      }
      coding = token.toLowerCase();
    }
    const q = parseWeightOnly(subject, item, segments.slice(1));
    return { coding, q, raw: item, index };
  });
}

/**
 * Parse an Accept-Charset header value, preserving order.
 * Per RFC 9110 §12.5.2 the header must contain at least one entry, so an
 * empty value is a syntax error (unlike the other Accept-* headers).
 */
export function parseAcceptCharset(value: string): CharsetRange[] {
  const subject = 'Accept-Charset';
  const ranges = splitHeaderList(subject, value).map((item, index) => {
    const segments = splitSegments(subject, item);
    const token = segments[0]!;
    let charset: string | null;
    if (token === '*') {
      charset = null;
    } else {
      if (!isToken(token)) {
        throw new NegotiationSyntaxError(subject, `invalid charset "${token}"`);
      }
      charset = token.toLowerCase();
    }
    const q = parseWeightOnly(subject, item, segments.slice(1));
    return { charset, q, raw: item, index };
  });
  if (ranges.length === 0) {
    throw new NegotiationSyntaxError(subject, 'at least one charset is required');
  }
  return ranges;
}

/**
 * Parse a concrete media type for a server candidate. Wildcards are not
 * allowed. A parameter named "q" has no special meaning here; it is kept
 * as an ordinary parameter.
 *
 * `subject` identifies the value in error messages, e.g. "candidates[0].mediaType".
 */
export function parseMediaType(value: string, subject: string): MediaType {
  const segments = splitSegments(subject, value);
  const { type, subtype } = parseTypeSubtype(subject, segments[0]!, false);
  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const parameter = parseParameter(subject, segment);
    if (params.has(parameter.name)) {
      throw new NegotiationSyntaxError(subject, `duplicate parameter "${parameter.name}" in "${value}"`);
    }
    params.set(parameter.name, parameter.value.toLowerCase());
  }
  return { type, subtype, params };
}
