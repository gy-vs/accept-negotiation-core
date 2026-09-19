/**
 * Table-driven parser tests: strict validation of case handling, optional
 * whitespace, duplicate parameters, q values, quoting and list structure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAccept,
  parseAcceptCharset,
  parseAcceptEncoding,
  parseAcceptLanguage,
  parseMediaTypeValue,
  type MediaRange,
  type TokenRange,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* Accept                                                              */
/* ------------------------------------------------------------------ */

interface AcceptOk {
  input: string;
  ranges: ReadonlyArray<{
    type: string;
    subtype: string;
    params?: ReadonlyArray<readonly [string, string]>;
    extensions?: ReadonlyArray<readonly [string, string | null]>;
    q?: number;
    raw?: string;
  }>;
}

const acceptOkCases: AcceptOk[] = [
  {
    input: 'text/html',
    ranges: [{ type: 'text', subtype: 'html', q: 1, params: [], raw: 'text/html' }],
  },
  {
    input: 'TEXT/HTML;LEVEL=1',
    ranges: [{ type: 'text', subtype: 'html', params: [['level', '1']], raw: 'TEXT/HTML;LEVEL=1' }],
  },
  {
    input: 'text/html; level=1; q=0.5',
    ranges: [{ type: 'text', subtype: 'html', params: [['level', '1']], q: 0.5 }],
  },
  {
    input: 'text/html;level=1 ; q=0.5',
    ranges: [{ type: 'text', subtype: 'html', params: [['level', '1']], q: 0.5 }],
  },
  { input: 'text/html;q=1.000', ranges: [{ type: 'text', subtype: 'html', q: 1 }] },
  { input: 'text/html;q=1.', ranges: [{ type: 'text', subtype: 'html', q: 1 }] },
  { input: 'text/html;q=0', ranges: [{ type: 'text', subtype: 'html', q: 0 }] },
  { input: 'text/html;q=0.', ranges: [{ type: 'text', subtype: 'html', q: 0 }] },
  { input: 'text/html;q=0.123', ranges: [{ type: 'text', subtype: 'html', q: 0.123 }] },
  { input: 'text/html;q=0.05', ranges: [{ type: 'text', subtype: 'html', q: 0.05 }] },
  { input: 'text/html;Q=0.5', ranges: [{ type: 'text', subtype: 'html', q: 0.5 }] },
  { input: '*/*', ranges: [{ type: '*', subtype: '*' }] },
  { input: 'text/*', ranges: [{ type: 'text', subtype: '*' }] },
  { input: 'text/*;q=0.3, text/html', ranges: [
    { type: 'text', subtype: '*', q: 0.3 },
    { type: 'text', subtype: 'html', q: 1 },
  ] },
  {
    input: 'text/html;level="1,2"',
    ranges: [{ type: 'text', subtype: 'html', params: [['level', '1,2']] }],
  },
  {
    input: 'text/html;title="a\\"b"',
    ranges: [{ type: 'text', subtype: 'html', params: [['title', 'a"b']] }],
  },
  {
    input: 'text/html;charset="UTF-8"',
    ranges: [{ type: 'text', subtype: 'html', params: [['charset', 'UTF-8']] }],
  },
  {
    // parameters after q are accept-extensions, not media type parameters
    input: 'text/html;q=0.5;level=1',
    ranges: [{ type: 'text', subtype: 'html', params: [], extensions: [['level', '1']], q: 0.5 }],
  },
  {
    input: 'text/html;q=0.5;ext',
    ranges: [{ type: 'text', subtype: 'html', extensions: [['ext', null]], q: 0.5 }],
  },
  {
    input: 'text/html,application/json',
    ranges: [
      { type: 'text', subtype: 'html', raw: 'text/html' },
      { type: 'application', subtype: 'json', raw: 'application/json' },
    ],
  },
  {
    input: '  text/html ,\tapplication/json  ',
    ranges: [
      { type: 'text', subtype: 'html', raw: 'text/html' },
      { type: 'application', subtype: 'json', raw: 'application/json' },
    ],
  },
  {
    // order is preserved verbatim, duplicates are allowed as list elements
    input: 'text/html, text/html;q=0.5',
    ranges: [
      { type: 'text', subtype: 'html', q: 1 },
      { type: 'text', subtype: 'html', q: 0.5 },
    ],
  },
];

for (const [i, c] of acceptOkCases.entries()) {
  test(`parseAccept ok #${i}: ${c.input}`, () => {
    const r = parseAccept(c.input);
    assert.ok(r.ok, `expected ok, got error: ${r.ok ? '' : r.error}`);
    assert.equal(r.value.length, c.ranges.length);
    for (const [j, expected] of c.ranges.entries()) {
      const actual = r.value[j] as MediaRange;
      assert.equal(actual.type, expected.type, `range ${j} type`);
      assert.equal(actual.subtype, expected.subtype, `range ${j} subtype`);
      assert.equal(actual.q, Math.round((expected.q ?? 1) * 1000), `range ${j} q`);
      assert.deepEqual(actual.params, expected.params ?? [], `range ${j} params`);
      assert.deepEqual(actual.extensions, expected.extensions ?? [], `range ${j} extensions`);
      assert.equal(actual.index, j, `range ${j} index`);
      if (expected.raw !== undefined) assert.equal(actual.raw, expected.raw);
    }
  });
}

const acceptErrCases: string[] = [
  '', // empty
  '   ', // whitespace only
  '*', // bare star is not a media range
  'text/html,,text/plain', // empty element
  'text/html,', // trailing comma
  ',text/html', // leading comma
  'text / html', // whitespace around "/"
  'text/ html',
  'text /html',
  'text', // missing subtype
  'text/', // missing subtype token
  '/html', // missing type
  '*/json', // wildcard type with concrete subtype
  'text/html;', // empty parameter
  'text/html;level', // media parameter without value
  'text/html;level=', // empty value
  'text/html;level=1;level=2', // duplicate parameter
  'text/html;LEVEL=1;level=2', // duplicate parameter, case-insensitive
  'text/html;q=0.5;q=0.6', // duplicate q
  'text/html;q=0.5;Q=0.6', // duplicate q, case-insensitive
  'text/html;q=0.5;level=1;level=2', // duplicate extension parameter
  'text/html;q', // q without value
  'text/html;q=', // empty q
  'text/html;q=2', // q > 1
  'text/html;q=1.1', // q > 1 with fraction
  'text/html;q=1.001', // 1 with non-zero fraction
  'text/html;q=0.1234', // more than 3 decimals
  'text/html;q=.5', // missing leading digit
  'text/html;q=-0.5', // negative
  'text/html;q="0.5"', // quoted q
  'text/html;level="unterminated', // unterminated quote
  'text/html;level="bad\\', // unterminated quoted-pair
  'text/html;level=one two', // whitespace inside value
  'text/html;*=1', // "*" is not a valid parameter name char sequence start? ("*" IS a token char, so this is actually valid) -- replaced below
  'text/html, text', // second element malformed
  'täxt/html', // non-ASCII in token
];

// "*=1" is a legal token-named parameter; drop that case and keep the rest.
const acceptErr = acceptErrCases.filter((s) => s !== 'text/html;*=1');

for (const input of acceptErr) {
  test(`parseAccept error: ${JSON.stringify(input)}`, () => {
    const r = parseAccept(input);
    assert.ok(!r.ok, `expected error, got ${JSON.stringify(r)}`);
    assert.equal(typeof r.ok === 'boolean' && !r.ok ? typeof r.error : '', 'string');
  });
}

test('parseAccept accepts "*" as a parameter name (token char)', () => {
  const r = parseAccept('text/html;*=1');
  assert.ok(r.ok);
});

/* ------------------------------------------------------------------ */
/* Accept-Language                                                     */
/* ------------------------------------------------------------------ */

interface TokenOk {
  input: string;
  ranges: ReadonlyArray<{ value: string; q?: number; raw?: string }>;
}

const languageOkCases: TokenOk[] = [
  { input: 'en-US, en;q=0.9, *;q=0.1', ranges: [{ value: 'en-us' }, { value: 'en', q: 0.9 }, { value: '*', q: 0.1 }] },
  { input: 'EN-us', ranges: [{ value: 'en-us' }] },
  { input: 'zh-Hans-CN', ranges: [{ value: 'zh-hans-cn' }] },
  { input: '*', ranges: [{ value: '*' }] },
  { input: 'de;q=0', ranges: [{ value: 'de', q: 0 }] },
  { input: 'fr ; q=0.5', ranges: [{ value: 'fr', q: 0.5, raw: 'fr ; q=0.5' }] },
];

for (const [i, c] of languageOkCases.entries()) {
  test(`parseAcceptLanguage ok #${i}: ${c.input}`, () => {
    const r = parseAcceptLanguage(c.input);
    assert.ok(r.ok, `expected ok, got error: ${r.ok ? '' : r.error}`);
    assert.equal(r.value.length, c.ranges.length);
    for (const [j, expected] of c.ranges.entries()) {
      const actual = r.value[j] as TokenRange;
      assert.equal(actual.value, expected.value);
      assert.equal(actual.q, Math.round((expected.q ?? 1) * 1000));
      assert.equal(actual.index, j);
      if (expected.raw !== undefined) assert.equal(actual.raw, expected.raw);
    }
  });
}

const languageErrCases: string[] = [
  '',
  'en_US', // underscore not allowed
  'en-', // trailing hyphen
  '-en', // leading hyphen
  'en--us', // empty subtag
  'abcdefghi', // 9-char subtag
  'en-abcdefghi', // 9-char later subtag
  '1en', // must start with ALPHA
  'en;q=0.5;foo=1', // only q allowed
  'en;foo=1', // only q allowed
  'en;q=0.5;q=0.6', // duplicate q
  'en,', // trailing comma
  'en,,fr', // empty element
  '**', // malformed wildcard
  '*-en', // wildcard must stand alone
];

for (const input of languageErrCases) {
  test(`parseAcceptLanguage error: ${JSON.stringify(input)}`, () => {
    const r = parseAcceptLanguage(input);
    assert.ok(!r.ok, `expected error, got ${JSON.stringify(r)}`);
  });
}

/* ------------------------------------------------------------------ */
/* Accept-Encoding / Accept-Charset                                    */
/* ------------------------------------------------------------------ */

test('parseAcceptEncoding ok', () => {
  const r = parseAcceptEncoding('gzip, br;q=0.8, identity;q=0.5, *;q=0.1');
  assert.ok(r.ok);
  assert.deepEqual(
    r.value.map((x) => [x.value, x.q]),
    [
      ['gzip', 1000],
      ['br', 800],
      ['identity', 500],
      ['*', 100],
    ],
  );
});

test('parseAcceptEncoding rejects parameters other than q', () => {
  assert.ok(!parseAcceptEncoding('gzip;level=1').ok);
});

test('parseAcceptCharset ok', () => {
  const r = parseAcceptCharset('UTF-8, iso-8859-1;q=0.5, *;q=0.1');
  assert.ok(r.ok);
  assert.deepEqual(
    r.value.map((x) => x.value),
    ['utf-8', 'iso-8859-1', '*'],
  );
});

test('parseAcceptCharset rejects bad q', () => {
  assert.ok(!parseAcceptCharset('utf-8;q=1.0000').ok);
});

/* ------------------------------------------------------------------ */
/* Server-side media type values                                       */
/* ------------------------------------------------------------------ */

test('parseMediaTypeValue ok', () => {
  const v = parseMediaTypeValue('Text/HTML; Level=1; charset="UTF-8"');
  assert.equal(v.type, 'text');
  assert.equal(v.subtype, 'html');
  assert.deepEqual(v.params, [
    ['level', '1'],
    ['charset', 'UTF-8'],
  ]);
});

const mediaValueErr = [
  'text/*',
  '*/*',
  'text/html;q=0.5', // q not allowed server-side
  'text/html;level=1;level=2',
  'text/html;level',
  'text/html extra',
  'text',
];
for (const input of mediaValueErr) {
  test(`parseMediaTypeValue error: ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseMediaTypeValue(input));
  });
}
