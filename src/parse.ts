/**
 * Strict parsers for the four Accept-* request headers and for server-side
 * representation metadata values.
 *
 * Design rules:
 *  - Client ranges keep their original order (`index` records the position).
 *  - Case is normalized exactly where the RFCs say values are case-insensitive
 *    (type/subtype, parameter names, language tags, codings, charsets).
 *    Parameter *values* stay case-sensitive.
 *  - Optional whitespace (SP / HTAB) is allowed around `,`, `;` and `=` only.
 *  - Duplicate parameter names (case-insensitive) are a hard error.
 *  - q values must match  qvalue = "0" ["." 0*3DIGIT] / "1" ["." 0*3"0"].
 *  - Anything malformed rejects the whole header (no silent recovery).
 */

export class ParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (offset ${position})`);
    this.name = 'ParseError';
    this.position = position;
  }
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}
function err<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Character classes                                                   */
/* ------------------------------------------------------------------ */

const TOKEN_SPECIALS = new Set("!#$%&'*+-.^_`|~".split(''));

function isTokenChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x30 && c <= 0x39) || // DIGIT
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    TOKEN_SPECIALS.has(ch)
  );
}

function isOWS(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

/* ------------------------------------------------------------------ */
/* Scanner                                                             */
/* ------------------------------------------------------------------ */

class Scanner {
  pos = 0;
  constructor(readonly input: string) {}

  get eof(): boolean {
    return this.pos >= this.input.length;
  }

  peek(): string {
    return this.input[this.pos] ?? '';
  }

  skipOWS(): void {
    while (!this.eof && isOWS(this.input[this.pos] as string)) this.pos++;
  }

  expect(ch: string, what: string): void {
    if (this.peek() !== ch) {
      throw new ParseError(`expected ${what}, found ${JSON.stringify(this.peek() || '<end>')}`, this.pos);
    }
    this.pos++;
  }

  readToken(what: string): string {
    const start = this.pos;
    while (!this.eof && isTokenChar(this.peek())) this.pos++;
    if (this.pos === start) throw new ParseError(`expected ${what}`, start);
    return this.input.slice(start, this.pos);
  }

  /** Reads a token that may also be a bare "*" wildcard. */
  readTokenOrStar(what: string): string {
    if (this.peek() === '*') {
      this.pos++;
      if (!this.eof && isTokenChar(this.peek())) {
        throw new ParseError(`wildcard "*" must stand alone in ${what}`, this.pos - 1);
      }
      return '*';
    }
    return this.readToken(what);
  }

  readQuotedString(): string {
    // Precondition: peek() === '"'
    this.pos++;
    let out = '';
    for (;;) {
      if (this.eof) throw new ParseError('unterminated quoted-string', this.pos);
      const ch = this.peek();
      const c = ch.charCodeAt(0);
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        this.pos++;
        if (this.eof) throw new ParseError('unterminated quoted-pair', this.pos);
        const n = this.peek();
        const nc = n.charCodeAt(0);
        if (!(nc === 0x09 || (nc >= 0x20 && nc <= 0x7e) || nc >= 0x80)) {
          throw new ParseError('invalid character in quoted-pair', this.pos);
        }
        out += n;
        this.pos++;
        continue;
      }
      // qdtext = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text
      const isQdtext =
        c === 0x09 || c === 0x20 || c === 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e) || c >= 0x80;
      if (!isQdtext) throw new ParseError('invalid character in quoted-string', this.pos);
      out += ch;
      this.pos++;
    }
  }

  /** Parameter values may be tokens or quoted-strings. */
  readParameterValue(what: string): string {
    if (this.peek() === '"') return this.readQuotedString();
    return this.readToken(what);
  }
}

/* ------------------------------------------------------------------ */
/* q values                                                            */
/* ------------------------------------------------------------------ */

const QVALUE_RE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parses a qvalue and returns milli-quality (0..1000 integer) so that all
 * downstream comparisons are exact integer arithmetic.
 */
export function parseQValue(raw: string, position: number): number {
  if (!QVALUE_RE.test(raw)) {
    throw new ParseError(`invalid q value ${JSON.stringify(raw)} (want 0..1 with at most 3 decimals)`, position);
  }
  if (raw.startsWith('1')) return 1000;
  const dot = raw.indexOf('.');
  if (dot === -1) return 0;
  return Number((raw.slice(dot + 1) + '000').slice(0, 3));
}

/* ------------------------------------------------------------------ */
/* Generic comma-list scaffolding (quote-aware, rejects empty items)   */
/* ------------------------------------------------------------------ */

function parseList<T>(input: string, element: (sc: Scanner, index: number) => T): T[] {
  if (input.trim().length === 0) {
    throw new ParseError('header value must not be empty', 0);
  }
  const sc = new Scanner(input);
  const out: T[] = [];
  for (;;) {
    sc.skipOWS();
    if (sc.eof) throw new ParseError('empty list element (trailing comma)', sc.pos);
    if (sc.peek() === ',') throw new ParseError('empty list element', sc.pos);
    out.push(element(sc, out.length));
    sc.skipOWS();
    if (sc.eof) return out;
    sc.expect(',', '"," between list elements');
  }
}

function toResult<T>(run: () => T): ParseResult<T> {
  try {
    return ok(run());
  } catch (e) {
    if (e instanceof ParseError) return err(e.message);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Accept (media ranges)                                               */
/* ------------------------------------------------------------------ */

export interface MediaRange {
  readonly type: string; // lowercased, or '*'
  readonly subtype: string; // lowercased, or '*'
  /** Parameters before `q` (media type parameters). Names lowercased, values verbatim. */
  readonly params: ReadonlyArray<readonly [string, string]>;
  /** Parameters after `q` (accept-ext). Value is null for a bare token. */
  readonly extensions: ReadonlyArray<readonly [string, string | null]>;
  readonly q: number; // milli-quality 0..1000
  readonly index: number; // position in the client header
  readonly raw: string; // original text of this element
}

function parseMediaRangeElement(sc: Scanner, index: number): MediaRange {
  const start = sc.pos;
  const type = sc.readTokenOrStar('media type').toLowerCase();
  sc.expect('/', '"/" between type and subtype');
  const subtype = sc.readTokenOrStar('media subtype').toLowerCase();
  if (type === '*' && subtype !== '*') {
    throw new ParseError('wildcard type requires wildcard subtype ("*/*")', start);
  }

  const params: Array<readonly [string, string]> = [];
  const extensions: Array<readonly [string, string | null]> = [];
  const seenNames = new Set<string>();
  let q = 1000;
  let seenQ = false;
  let end = sc.pos; // end of the element, excluding trailing OWS

  for (;;) {
    sc.skipOWS();
    if (sc.peek() !== ';') break;
    sc.pos++;
    sc.skipOWS();
    const nameStart = sc.pos;
    const name = sc.readToken('parameter name').toLowerCase();
    if (seenNames.has(name)) {
      throw new ParseError(`duplicate parameter "${name}"`, nameStart);
    }
    seenNames.add(name);
    sc.skipOWS();
    if (name === 'q') {
      // q values are bare tokens; a quoted q is rejected by readToken.
      sc.expect('=', '"=" after parameter "q"');
      sc.skipOWS();
      q = parseQValue(sc.readToken('q value'), nameStart);
      seenQ = true;
      end = sc.pos;
      continue;
    }
    let value: string | null = null;
    if (sc.peek() === '=') {
      sc.pos++;
      sc.skipOWS();
      value = sc.readParameterValue(`value for parameter "${name}"`);
    }
    if (!seenQ) {
      if (value === null) {
        throw new ParseError(`media type parameter "${name}" requires a value`, nameStart);
      }
      params.push([name, value]);
    } else {
      extensions.push([name, value]);
    }
    end = sc.pos;
  }

  return { type, subtype, params, extensions, q, index, raw: sc.input.slice(start, end) };
}

export function parseAccept(input: string): ParseResult<readonly MediaRange[]> {
  return toResult(() => parseList(input, parseMediaRangeElement));
}

/* ------------------------------------------------------------------ */
/* Accept-Language / Accept-Encoding / Accept-Charset (token ranges)   */
/* ------------------------------------------------------------------ */

export interface TokenRange {
  readonly value: string; // lowercased token, or '*'
  readonly q: number; // milli-quality 0..1000
  readonly index: number;
  readonly raw: string;
}

interface TokenListOptions {
  /** Extra validation for the element value ("*" already handled). */
  readonly validateValue?: (value: string, position: number) => void;
  readonly what: string;
}

function parseTokenList(input: string, opts: TokenListOptions): ParseResult<readonly TokenRange[]> {
  return toResult(() =>
    parseList(input, (sc, index) => {
      const start = sc.pos;
      const value = sc.readTokenOrStar(opts.what).toLowerCase();
      if (value !== '*' && opts.validateValue) opts.validateValue(value, start);

      let q = 1000;
      let seenQ = false;
      let end = sc.pos; // end of the element, excluding trailing OWS
      for (;;) {
        sc.skipOWS();
        if (sc.peek() !== ';') break;
        sc.pos++;
        sc.skipOWS();
        const nameStart = sc.pos;
        const name = sc.readToken('parameter name').toLowerCase();
        if (name !== 'q') {
          throw new ParseError(`parameter "${name}" is not allowed in a ${opts.what} range (only "q")`, nameStart);
        }
        if (seenQ) throw new ParseError('duplicate parameter "q"', nameStart);
        seenQ = true;
        sc.skipOWS();
        sc.expect('=', '"=" after parameter "q"');
        sc.skipOWS();
        // q values are bare tokens; a quoted q is rejected by readToken.
        q = parseQValue(sc.readToken('q value'), nameStart);
        end = sc.pos;
      }

      return { value, q, index, raw: sc.input.slice(start, end) } satisfies TokenRange;
    }),
  );
}

const LANGUAGE_RANGE_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

export function parseAcceptLanguage(input: string): ParseResult<readonly TokenRange[]> {
  return parseTokenList(input, {
    what: 'language',
    validateValue: (value, position) => {
      if (!LANGUAGE_RANGE_RE.test(value)) {
        throw new ParseError(`invalid language range ${JSON.stringify(value)}`, position);
      }
    },
  });
}

export function parseAcceptEncoding(input: string): ParseResult<readonly TokenRange[]> {
  return parseTokenList(input, { what: 'encoding' });
}

export function parseAcceptCharset(input: string): ParseResult<readonly TokenRange[]> {
  return parseTokenList(input, { what: 'charset' });
}

/* ------------------------------------------------------------------ */
/* Server-side representation metadata                                 */
/* ------------------------------------------------------------------ */

export interface MediaTypeValue {
  readonly type: string; // lowercased, never '*'
  readonly subtype: string; // lowercased, never '*'
  readonly params: ReadonlyArray<readonly [string, string]>;
}

/** Parses a concrete (non-wildcard) media type for a server variant. Throws ParseError. */
export function parseMediaTypeValue(input: string): MediaTypeValue {
  const sc = new Scanner(input);
  sc.skipOWS();
  const start = sc.pos;
  const type = sc.readToken('media type').toLowerCase();
  if (type === '*') throw new ParseError('server media type must not be a wildcard', start);
  sc.expect('/', '"/" between type and subtype');
  const subtype = sc.readToken('media subtype').toLowerCase();
  if (subtype === '*') throw new ParseError('server media type must not be a wildcard', start);

  const params: Array<readonly [string, string]> = [];
  const seenNames = new Set<string>();
  for (;;) {
    sc.skipOWS();
    if (sc.eof) break;
    sc.expect(';', '";" before media type parameter');
    sc.skipOWS();
    const nameStart = sc.pos;
    const name = sc.readToken('parameter name').toLowerCase();
    if (name === 'q') throw new ParseError('parameter "q" is not allowed in a server media type', nameStart);
    if (seenNames.has(name)) throw new ParseError(`duplicate parameter "${name}"`, nameStart);
    seenNames.add(name);
    sc.skipOWS();
    sc.expect('=', `"=" after parameter "${name}"`);
    sc.skipOWS();
    params.push([name, sc.readParameterValue(`value for parameter "${name}"`)]);
  }
  sc.skipOWS();
  if (!sc.eof) throw new ParseError('unexpected trailing characters', sc.pos);
  return { type, subtype, params };
}

const LANGUAGE_TAG_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** Validates and lowercases a language tag for a server variant. Throws ParseError. */
export function normalizeLanguageTag(input: string): string {
  const trimmed = input.trim();
  if (!LANGUAGE_TAG_RE.test(trimmed)) {
    throw new ParseError(`invalid language tag ${JSON.stringify(input)}`, 0);
  }
  return trimmed.toLowerCase();
}

/** Validates and lowercases a content-coding / charset token. Throws ParseError. */
export function normalizeToken(input: string, what: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new ParseError(`${what} must not be empty`, 0);
  if (trimmed === '*') throw new ParseError(`${what} must not be a wildcard`, 0);
  for (const ch of trimmed) {
    if (!isTokenChar(ch)) {
      throw new ParseError(`invalid character ${JSON.stringify(ch)} in ${what}`, 0);
    }
  }
  return trimmed.toLowerCase();
}
