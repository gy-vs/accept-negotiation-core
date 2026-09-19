/**
 * Low-level HTTP syntax helpers (RFC 9110).
 *
 * These implement strict validation:
 * - tokens must consist of tchar only,
 * - optional whitespace (OWS = SP / HTAB) is allowed around list elements
 *   and around `;` separators, but NOT inside tokens or around `=`,
 * - quoted-strings support quoted-pair escapes and reject CR/LF,
 * - q values must match the `qvalue` grammar exactly.
 */
import { NegotiationSyntaxError } from './errors.js';

const TCHAR_EXTRA = "!#$%&'*+-.^_`|~";

export function isTokenChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code < 0x80 && TCHAR_EXTRA.includes(String.fromCharCode(code)))
  );
}

export function isToken(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    if (!isTokenChar(value.charCodeAt(i))) return false;
  }
  return true;
}

/** Strip optional whitespace (SP / HTAB) from both ends. */
export function stripOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start++;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
  return value.slice(start, end);
}

function assertNoLineBreaks(subject: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\r' || ch === '\n') {
      throw new NegotiationSyntaxError(subject, 'line breaks are not allowed');
    }
  }
}

/**
 * Split a `#rule` header value into list elements on commas, honoring
 * quoted-strings (a comma inside a quoted-string does not split).
 * Empty elements are dropped, as required by the #rule ABNF convention.
 * Original element order is preserved.
 */
export function splitHeaderList(subject: string, value: string): string[] {
  assertNoLineBreaks(subject, value);
  const items: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inQuotes) {
      current += ch;
      if (ch === '\\') {
        if (i + 1 >= value.length) {
          throw new NegotiationSyntaxError(subject, 'dangling backslash in quoted-string');
        }
        current += value[i + 1]!;
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuotes) {
    throw new NegotiationSyntaxError(subject, 'unterminated quoted-string');
  }
  items.push(current);
  return items.map(stripOws).filter((item) => item.length > 0);
}

/**
 * Split one list element into `;`-separated segments, honoring
 * quoted-strings. Each segment is OWS-trimmed. Empty segments are a
 * syntax error (strict).
 */
export function splitSegments(subject: string, item: string): string[] {
  assertNoLineBreaks(subject, item);
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i]!;
    if (inQuotes) {
      current += ch;
      if (ch === '\\') {
        if (i + 1 >= item.length) {
          throw new NegotiationSyntaxError(subject, 'dangling backslash in quoted-string');
        }
        current += item[i + 1]!;
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === ';') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuotes) {
    throw new NegotiationSyntaxError(subject, 'unterminated quoted-string');
  }
  segments.push(current);
  const trimmed = segments.map(stripOws);
  for (const segment of trimmed) {
    if (segment.length === 0) {
      throw new NegotiationSyntaxError(subject, `empty parameter segment in "${item}"`);
    }
  }
  return trimmed;
}

export interface Parameter {
  /** Lowercased parameter name. */
  readonly name: string;
  /** Unescaped parameter value (case preserved). */
  readonly value: string;
}

/**
 * Parse a `name=value` parameter. The name must be a token; the value must
 * be a token or a quoted-string. No whitespace is allowed around `=`.
 */
export function parseParameter(subject: string, segment: string): Parameter {
  const eq = segment.indexOf('=');
  if (eq <= 0) {
    throw new NegotiationSyntaxError(subject, `parameter "${segment}" is missing "="`);
  }
  const name = segment.slice(0, eq);
  if (!isToken(name)) {
    throw new NegotiationSyntaxError(subject, `invalid parameter name in "${segment}"`);
  }
  const rawValue = segment.slice(eq + 1);
  if (rawValue.length === 0) {
    throw new NegotiationSyntaxError(subject, `parameter "${name}" has an empty value`);
  }
  let value: string;
  if (rawValue.startsWith('"')) {
    value = parseQuotedString(subject, rawValue);
  } else {
    if (!isToken(rawValue)) {
      throw new NegotiationSyntaxError(
        subject,
        `invalid value for parameter "${name}" (expected a token or quoted-string)`,
      );
    }
    value = rawValue;
  }
  return { name: name.toLowerCase(), value };
}

/** Parse and unescape a quoted-string. The input must start and end with DQUOTE. */
export function parseQuotedString(subject: string, raw: string): string {
  if (raw.length < 2 || !raw.endsWith('"')) {
    throw new NegotiationSyntaxError(subject, `malformed quoted-string ${JSON.stringify(raw)}`);
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i]!;
    if (ch === '\\') {
      if (i + 1 >= raw.length - 1) {
        throw new NegotiationSyntaxError(subject, 'dangling backslash in quoted-string');
      }
      const next = raw[i + 1]!;
      if (next === '\r' || next === '\n') {
        throw new NegotiationSyntaxError(subject, 'line breaks are not allowed in quoted-string');
      }
      out += next;
      i++;
    } else if (ch === '"') {
      throw new NegotiationSyntaxError(subject, 'unescaped double quote in quoted-string');
    } else if (ch === '\r' || ch === '\n') {
      throw new NegotiationSyntaxError(subject, 'line breaks are not allowed in quoted-string');
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )
 * Note: per the grammar, "0." and "1." are legal.
 */
const QVALUE_RE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parse a `q=<qvalue>` weight segment. The value must match the qvalue
 * grammar exactly: no quotes, no whitespace, at most 3 decimals, and a
 * value of 1 may only have zero decimals.
 */
export function parseWeightSegment(subject: string, segment: string): number {
  const eq = segment.indexOf('=');
  if (eq !== 1 || (segment[0] !== 'q' && segment[0] !== 'Q')) {
    throw new NegotiationSyntaxError(subject, `malformed weight parameter "${segment}"`);
  }
  const raw = segment.slice(2);
  if (!QVALUE_RE.test(raw)) {
    throw new NegotiationSyntaxError(
      subject,
      `invalid q value "${raw}" (expected "0", "0.xxx", "1" or "1.000" with at most 3 decimals)`,
    );
  }
  return Number(raw);
}

/** Extract the lowercase parameter name of a segment (text before the first `=`). */
export function segmentName(segment: string): string {
  const eq = segment.indexOf('=');
  return (eq === -1 ? segment : segment.slice(0, eq)).toLowerCase();
}
