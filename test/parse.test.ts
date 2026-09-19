import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NegotiationSyntaxError,
  parseAccept,
  parseAcceptCharset,
  parseAcceptEncoding,
  parseAcceptLanguage,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

test('Accept: order is preserved and indices are assigned in client order', () => {
  const ranges = parseAccept('application/json;q=0.9, text/html, text/*;q=0.5');
  assert.equal(ranges.length, 3);
  assert.deepEqual(
    ranges.map((r) => [r.type, r.subtype, r.index]),
    [
      ['application', 'json', 0],
      ['text', 'html', 1],
      ['text', '*', 2],
    ],
  );
  assert.equal(ranges[0]!.q, 0.9);
  assert.equal(ranges[1]!.q, 1);
  assert.equal(ranges[2]!.q, 0.5);
});

test('Accept: case is normalized, raw text is preserved', () => {
  const [range] = parseAccept('TEXT/HTML;Level=1;Q=0.5');
  assert.equal(range!.type, 'text');
  assert.equal(range!.subtype, 'html');
  assert.deepEqual(range!.params, [['level', '1']]);
  assert.equal(range!.q, 0.5);
  assert.equal(range!.raw, 'TEXT/HTML;Level=1;Q=0.5');
});

test('Accept: optional whitespace around elements and semicolons', () => {
  const ranges = parseAccept(' \t text/html \t;\t level=1 \t;\t q=0.5 \t,\tapplication/json ');
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.type, 'text');
  assert.deepEqual(ranges[0]!.params, [['level', '1']]);
  assert.equal(ranges[0]!.q, 0.5);
  assert.equal(ranges[1]!.type, 'application');
});

test('Accept: empty list elements are ignored', () => {
  const ranges = parseAccept('text/html,, ,application/json,');
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.subtype, 'html');
  assert.equal(ranges[1]!.subtype, 'json');
});

test('Accept: empty header value yields an empty list', () => {
  assert.deepEqual(parseAccept(''), []);
  assert.deepEqual(parseAccept('  , \t '), []);
});

test('Accept: duplicate list entries are kept (first wins on ties)', () => {
  const ranges = parseAccept('text/html, text/html;q=0.5');
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.q, 1);
  assert.equal(ranges[1]!.q, 0.5);
});

test('Accept: parameters after q are accept extensions', () => {
  const [range] = parseAccept('text/html;level=1;q=0.5;ext=2;note="a,b;c"');
  assert.deepEqual(range!.params, [['level', '1']]);
  assert.equal(range!.q, 0.5);
  assert.deepEqual(range!.extensions, [
    ['ext', '2'],
    ['note', 'a,b;c'],
  ]);
});

test('Accept: quoted-string parameter values with escapes', () => {
  const [range] = parseAccept('text/html;title="He said \\"hi\\", ok"');
  assert.deepEqual(range!.params, [['title', 'he said "hi", ok']]);
});

test('Accept: parameter values are lowercased for comparison', () => {
  const [range] = parseAccept('text/html;charset="UTF-8"');
  assert.deepEqual(range!.params, [['charset', 'utf-8']]);
});

const VALID_Q: ReadonlyArray<readonly [string, number]> = [
  ['0', 0],
  ['0.', 0],
  ['0.0', 0],
  ['0.00', 0],
  ['0.000', 0],
  ['0.5', 0.5],
  ['0.999', 0.999],
  ['1', 1],
  ['1.', 1],
  ['1.0', 1],
  ['1.00', 1],
  ['1.000', 1],
];

for (const [text, expected] of VALID_Q) {
  test(`Accept: q=${text} is valid`, () => {
    const [range] = parseAccept(`text/html;q=${text}`);
    assert.equal(range!.q, expected);
  });
}

const INVALID_Q = [
  '2',
  '1.5',
  '1.0000',
  '1.001',
  '0.0000',
  '0.1234',
  '.5',
  '-0.5',
  '0.5.5',
  '00.5',
  '01',
  'q',
  '',
  '"0.5"',
  ' 0.5',
  '0,5',
];

for (const q of INVALID_Q) {
  test(`Accept: q=${JSON.stringify(q)} is rejected`, () => {
    assert.throws(() => parseAccept(`text/html;q=${q}`), NegotiationSyntaxError);
  });
}

test('Accept: whitespace around = in q is rejected', () => {
  assert.throws(() => parseAccept('text/html;q =0.5'), NegotiationSyntaxError);
  assert.throws(() => parseAccept('text/html;q= 0.5'), NegotiationSyntaxError);
  assert.throws(() => parseAccept('text/html;q\t=0.5'), NegotiationSyntaxError);
});

const INVALID_ACCEPT = [
  'text',
  'text/',
  '/html',
  'text/html/extra',
  '*/json',
  'text /html',
  'text/ html',
  'te xt/html',
  'text/html;a=1;a=2', // duplicate parameter
  'text/html;a=1;q=0.5;a=2', // duplicate across params/extensions
  'text/html;q=0.5;q=0.6', // duplicate q
  'text/html;foo', // parameter without value
  'text/html;', // trailing empty segment
  'text/html;;a=1', // empty segment
  'text/html;title="unterminated',
  'text/html;title="a"b"', // stray quote
  'text/html;title=va"l', // quote inside token
  'text/html;level==1', // empty-ish value
  'text/html;q', // q without value
  'text/html;q=', // empty q
  'text/html;a="\\"', // dangling escape
];

for (const value of INVALID_ACCEPT) {
  test(`Accept: ${JSON.stringify(value)} is rejected`, () => {
    assert.throws(() => parseAccept(value), NegotiationSyntaxError);
  });
}

// ---------------------------------------------------------------------------
// Accept-Language
// ---------------------------------------------------------------------------

test('Accept-Language: ranges, weights, wildcard, order', () => {
  const ranges = parseAcceptLanguage('en-US, en;q=0.9, *;q=0.1');
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges[0]!.subtags, ['en', 'us']);
  assert.equal(ranges[0]!.q, 1);
  assert.deepEqual(ranges[1]!.subtags, ['en']);
  assert.equal(ranges[1]!.q, 0.9);
  assert.equal(ranges[2]!.subtags, null);
  assert.equal(ranges[2]!.index, 2);
});

test('Accept-Language: case is normalized, raw preserved', () => {
  const [range] = parseAcceptLanguage('ZH-Hant-CN');
  assert.deepEqual(range!.subtags, ['zh', 'hant', 'cn']);
  assert.equal(range!.raw, 'ZH-Hant-CN');
});

test('Accept-Language: empty header yields an empty list', () => {
  assert.deepEqual(parseAcceptLanguage(''), []);
});

const INVALID_LANGUAGE = [
  'en-',
  '-en',
  'en--us',
  'abcdefghi', // 9-letter primary subtag
  'en-abcdefghi', // 9-letter subtag
  '1en', // primary subtag must be alpha
  '*-us', // extended filtering is not supported
  '**',
  'en_us',
  'en us',
  'en;q=0.5;foo=1', // no extensions allowed
  'en;foo=1',
  'en;q=0.5;q=0.7',
  'en;q=2',
];

for (const value of INVALID_LANGUAGE) {
  test(`Accept-Language: ${JSON.stringify(value)} is rejected`, () => {
    assert.throws(() => parseAcceptLanguage(value), NegotiationSyntaxError);
  });
}

test('Accept-Language: numeric and short subtags are valid', () => {
  const ranges = parseAcceptLanguage('en-1, de-1901, es-419');
  assert.deepEqual(ranges[0]!.subtags, ['en', '1']);
  assert.deepEqual(ranges[1]!.subtags, ['de', '1901']);
  assert.deepEqual(ranges[2]!.subtags, ['es', '419']);
});

// ---------------------------------------------------------------------------
// Accept-Encoding
// ---------------------------------------------------------------------------

test('Accept-Encoding: codings, weights, wildcard, case', () => {
  const ranges = parseAcceptEncoding('gzip, BR;q=0.8, identity;q=0, *;q=0.1');
  assert.deepEqual(
    ranges.map((r) => [r.coding, r.q]),
    [
      ['gzip', 1],
      ['br', 0.8],
      ['identity', 0],
      [null, 0.1],
    ],
  );
});

test('Accept-Encoding: empty header yields an empty list', () => {
  assert.deepEqual(parseAcceptEncoding(''), []);
});

const INVALID_ENCODING = ['g zip', 'gzip;q=9', 'gzip;foo=1', 'gzip;q=0.5;q=0.6', '"gzip"'];

for (const value of INVALID_ENCODING) {
  test(`Accept-Encoding: ${JSON.stringify(value)} is rejected`, () => {
    assert.throws(() => parseAcceptEncoding(value), NegotiationSyntaxError);
  });
}

// ---------------------------------------------------------------------------
// Accept-Charset
// ---------------------------------------------------------------------------

test('Accept-Charset: charsets, weights, wildcard', () => {
  const ranges = parseAcceptCharset('UTF-8, iso-8859-1;q=0.5, *;q=0.1');
  assert.deepEqual(
    ranges.map((r) => [r.charset, r.q]),
    [
      ['utf-8', 1],
      ['iso-8859-1', 0.5],
      [null, 0.1],
    ],
  );
});

test('Accept-Charset: empty header is a syntax error (1# rule)', () => {
  assert.throws(() => parseAcceptCharset(''), NegotiationSyntaxError);
  assert.throws(() => parseAcceptCharset(' , '), NegotiationSyntaxError);
});

test('Accept-Charset: only q parameter allowed', () => {
  assert.throws(() => parseAcceptCharset('utf-8;foo=1'), NegotiationSyntaxError);
});
