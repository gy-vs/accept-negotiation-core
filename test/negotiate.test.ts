/**
 * Table-driven negotiation tests: matching semantics per dimension, weighted
 * scoring, the full tie-break chain, elimination, absence vs. wildcard, and
 * Vary computation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiate,
  varyFor,
  type NegotiateOptions,
  type Variant,
} from '../src/index.js';

interface V extends Variant {
  readonly id: string;
}

function run(variants: readonly V[], options: NegotiateOptions) {
  return negotiate<V>(variants, options);
}

/* ------------------------------------------------------------------ */
/* Media type matching                                                 */
/* ------------------------------------------------------------------ */

test('exact match beats subtype wildcard beats type wildcard', () => {
  const variants: V[] = [
    { id: 'png', mediaType: 'image/png' },
    { id: 'html', mediaType: 'text/html' },
    { id: 'any-text', mediaType: 'text/plain' },
  ];
  const r = run(variants, { headers: { accept: 'text/html;q=0.9, text/*;q=0.5, */*;q=0.1' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'html');
  const byId = new Map(r.candidates.map((c) => [c.variant.id, c]));
  assert.equal(byId.get('html')?.dimensions.mediaType.quality, 0.9);
  assert.deepEqual(byId.get('html')?.dimensions.mediaType.specificity, [2, 0]);
  assert.equal(byId.get('any-text')?.dimensions.mediaType.quality, 0.5);
  assert.deepEqual(byId.get('any-text')?.dimensions.mediaType.specificity, [1, 0]);
  assert.equal(byId.get('png')?.dimensions.mediaType.quality, 0.1);
  assert.deepEqual(byId.get('png')?.dimensions.mediaType.specificity, [0, 0]);
});

test('parameter specificity: range with more matching params wins, params must subset', () => {
  const variants: V[] = [
    { id: 'plain', mediaType: 'text/html' },
    { id: 'leveled', mediaType: 'text/html;level=1' },
  ];
  const r = run(variants, { headers: { accept: 'text/html, text/html;level=1;q=0.5' } });
  assert.equal(r.status, 'ok');
  const byId = new Map(r.candidates.map((c) => [c.variant.id, c]));
  // The leveled variant matches both ranges; the more specific one (q=0.5) applies.
  assert.equal(byId.get('leveled')?.dimensions.mediaType.quality, 0.5);
  assert.deepEqual(byId.get('leveled')?.dimensions.mediaType.specificity, [2, 1]);
  // The plain variant does not satisfy the level=1 parameter requirement.
  assert.equal(byId.get('plain')?.dimensions.mediaType.quality, 1);
  assert.equal(r.winner?.variant.id, 'plain');
});

test('media parameter values are case-sensitive, names are not', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/html;level=1' }];
  const upper = run(variants, { headers: { accept: 'text/html;LEVEL=1' } });
  assert.equal(upper.status, 'ok');
  const mismatch = run(variants, { headers: { accept: 'text/html;level=2' } });
  assert.equal(mismatch.status, 'not-negotiable');
});

test('q=0 excludes explicitly even when a wildcard also matches', () => {
  const variants: V[] = [
    { id: 'html', mediaType: 'text/html' },
    { id: 'json', mediaType: 'application/json' },
  ];
  const r = run(variants, { headers: { accept: 'text/html;q=0, */*;q=0.5' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'json');
  const html = r.candidates.find((c) => c.variant.id === 'html');
  assert.equal(html?.eliminated, true);
  assert.deepEqual(html?.eliminationReasons, ['mediaType:q-zero']);
  assert.equal(html?.dimensions.mediaType.reason, 'q-zero');
  assert.equal(html?.dimensions.mediaType.rangeRaw, 'text/html;q=0');
});

/* ------------------------------------------------------------------ */
/* Language matching                                                   */
/* ------------------------------------------------------------------ */

test('language prefix truncation: longest matching range wins', () => {
  const variants: V[] = [
    { id: 'en-us', language: 'en-US' },
    { id: 'en-gb', language: 'en-GB' },
    { id: 'fr', language: 'fr' },
  ];
  const r = run(variants, { headers: { acceptLanguage: 'en;q=0.8, en-US;q=0.9' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'en-us');
  const byId = new Map(r.candidates.map((c) => [c.variant.id, c]));
  assert.equal(byId.get('en-us')?.dimensions.language.quality, 0.9);
  assert.deepEqual(byId.get('en-us')?.dimensions.language.specificity, [2]);
  assert.equal(byId.get('en-gb')?.dimensions.language.quality, 0.8);
  assert.deepEqual(byId.get('en-gb')?.dimensions.language.specificity, [1]);
  assert.equal(byId.get('fr')?.eliminated, true);
  assert.deepEqual(byId.get('fr')?.eliminationReasons, ['language:no-match']);
});

test('language range does not match shorter tags; star matches untagged variants', () => {
  const variants: V[] = [{ id: 'en', language: 'en' }, { id: 'none' }];
  const noStar = run(variants, { headers: { acceptLanguage: 'en-US' } });
  assert.equal(noStar.status, 'not-negotiable');
  assert.equal(noStar.candidates[0]?.dimensions.language.matched, false);

  const withStar = run(variants, { headers: { acceptLanguage: 'en-US, *;q=0.1' } });
  assert.equal(withStar.status, 'ok');
  const byId = new Map(withStar.candidates.map((c) => [c.variant.id, c]));
  assert.equal(byId.get('en')?.dimensions.language.quality, 0.1);
  assert.deepEqual(byId.get('en')?.dimensions.language.specificity, [0]);
  assert.equal(byId.get('none')?.dimensions.language.quality, 0.1);
});

/* ------------------------------------------------------------------ */
/* Encoding matching                                                   */
/* ------------------------------------------------------------------ */

test('identity is acceptable by default but loses on specificity', () => {
  const variants: V[] = [
    { id: 'identity' },
    { id: 'gzip', encoding: 'gzip' },
  ];
  const r = run(variants, { headers: { acceptEncoding: 'gzip' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'gzip');
  const identity = r.candidates.find((c) => c.variant.id === 'identity');
  assert.equal(identity?.dimensions.encoding.quality, 1);
  assert.equal(identity?.dimensions.encoding.rangeIndex, null);
  assert.match(identity?.dimensions.encoding.note ?? '', /identity/);
  assert.deepEqual(identity?.dimensions.encoding.specificity, [0]);
});

test('identity;q=0 and star;q=0 exclude identity', () => {
  const variants: V[] = [{ id: 'identity' }, { id: 'gzip', encoding: 'gzip' }];
  const r1 = run(variants, { headers: { acceptEncoding: 'gzip, identity;q=0' } });
  assert.equal(r1.winner?.variant.id, 'gzip');
  assert.deepEqual(
    r1.candidates.find((c) => c.variant.id === 'identity')?.eliminationReasons,
    ['encoding:q-zero'],
  );
  const r2 = run(variants, { headers: { acceptEncoding: 'gzip, *;q=0' } });
  assert.equal(r2.winner?.variant.id, 'gzip');
  assert.deepEqual(
    r2.candidates.find((c) => c.variant.id === 'identity')?.eliminationReasons,
    ['encoding:q-zero'],
  );
});

test('unlisted non-identity coding without star is eliminated', () => {
  const variants: V[] = [{ id: 'br', encoding: 'br' }];
  const r = run(variants, { headers: { acceptEncoding: 'gzip' } });
  assert.equal(r.status, 'not-negotiable');
  assert.deepEqual(r.candidates[0]?.eliminationReasons, ['encoding:no-match']);
});

/* ------------------------------------------------------------------ */
/* Charset matching                                                    */
/* ------------------------------------------------------------------ */

test('charset exact and star; variant without charset needs star', () => {
  const variants: V[] = [
    { id: 'utf8', charset: 'utf-8' },
    { id: 'none' },
  ];
  const r = run(variants, { headers: { acceptCharset: 'utf-8;q=0.5, *;q=0.2' } });
  assert.equal(r.status, 'ok');
  const byId = new Map(r.candidates.map((c) => [c.variant.id, c]));
  assert.equal(byId.get('utf8')?.dimensions.charset.quality, 0.5);
  assert.equal(byId.get('none')?.dimensions.charset.quality, 0.2);

  const strict = run(variants, { headers: { acceptCharset: 'utf-8' } });
  assert.equal(strict.candidates.find((c) => c.variant.id === 'none')?.eliminated, true);
});

/* ------------------------------------------------------------------ */
/* Weighted scoring                                                    */
/* ------------------------------------------------------------------ */

test('dimension weights decide the winner', () => {
  const variants: V[] = [
    { id: 'A', mediaType: 'text/html', language: 'en' }, // media 1.0, lang 0.5
    { id: 'B', mediaType: 'text/plain', language: 'en-US' }, // media 0.5, lang 1.0
  ];
  const headers = { accept: 'text/html, text/plain;q=0.5', acceptLanguage: 'en-US, en;q=0.5' };

  const balanced = run(variants, { headers, weights: { mediaType: 1, language: 1 } });
  assert.equal(balanced.status, 'ok');
  // Both score 0.75; specificity: A has media [2,0] vs B media [2,0]; language
  // A [1] vs B [2] -> B wins on specificity.
  assert.equal(balanced.winner?.variant.id, 'B');

  const mediaHeavy = run(variants, { headers, weights: { mediaType: 3, language: 1 } });
  assert.equal(mediaHeavy.winner?.variant.id, 'A');
  assert.equal(mediaHeavy.winner?.score, (3 * 1 + 1 * 0.5) / 4);

  const languageHeavy = run(variants, { headers, weights: { mediaType: 1, language: 3 } });
  assert.equal(languageHeavy.winner?.variant.id, 'B');
});

test('absent dimensions are excluded from the weight sum', () => {
  const variants: V[] = [
    { id: 'A', mediaType: 'text/html' },
    { id: 'B', mediaType: 'text/plain' },
  ];
  const r = run(variants, {
    headers: { accept: 'text/html;q=0.5, text/plain;q=0.5' },
    weights: { mediaType: 1, language: 99 },
  });
  assert.equal(r.status, 'ok');
  // language is absent -> its weight must not dilute the score.
  assert.equal(r.winner?.score, 0.5);
  assert.equal(r.dimensions.language.weight, 0);
  assert.equal(r.dimensions.language.participated, false);
});

/* ------------------------------------------------------------------ */
/* Tie-break chain                                                     */
/* ------------------------------------------------------------------ */

test('tie on quality: specificity decides', () => {
  const variants: V[] = [
    { id: 'wild', mediaType: 'text/html' },
    { id: 'exact', mediaType: 'text/html;level=1' },
  ];
  const r = run(variants, { headers: { accept: 'text/*, text/html;level=1' } });
  assert.equal(r.status, 'ok');
  // both have q=1; "exact" matches [2,1] vs "wild" [1,0]
  assert.equal(r.winner?.variant.id, 'exact');
});

test('tie on quality and specificity: client range order decides', () => {
  const variants: V[] = [
    { id: 'json-first-server', mediaType: 'application/json' },
    { id: 'html', mediaType: 'text/html' },
  ];
  const r = run(variants, { headers: { accept: 'text/html, application/json' } });
  assert.equal(r.status, 'ok');
  // Both q=1, both specificity [2,0]; html's range comes first in the header.
  assert.equal(r.winner?.variant.id, 'html');
});

test('tie on everything: server order decides', () => {
  const variants: V[] = [
    { id: 'first', mediaType: 'text/html' },
    { id: 'second', mediaType: 'text/html' },
  ];
  const r = run(variants, { headers: { accept: 'text/html' } });
  assert.equal(r.winner?.variant.id, 'first');
});

/* ------------------------------------------------------------------ */
/* Absence vs. explicit star                                           */
/* ------------------------------------------------------------------ */

test('absent header and explicit star are distinct states', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/html' }];
  const absent = run(variants, { headers: {} });
  assert.equal(absent.dimensions.mediaType.state, 'absent');
  assert.equal(absent.dimensions.mediaType.participated, false);
  assert.equal(absent.candidates[0]?.dimensions.mediaType.participated, false);

  const star = run(variants, { headers: { accept: '*/*' } });
  assert.equal(star.dimensions.mediaType.state, 'present');
  assert.equal(star.candidates[0]?.dimensions.mediaType.participated, true);
  assert.equal(star.candidates[0]?.dimensions.mediaType.rangeRaw, '*/*');
});

test('no headers at all: first variant wins, score 1, empty vary', () => {
  const variants: V[] = [{ id: 'a' }, { id: 'b' }];
  const r = run(variants, { headers: {} });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'a');
  assert.equal(r.winner?.score, 1);
  assert.deepEqual(r.vary, []);
});

test('all-zero participating weights fall back to equal weights', () => {
  const variants: V[] = [
    { id: 'A', mediaType: 'text/html' },
    { id: 'B', mediaType: 'text/plain' },
  ];
  const r = run(variants, {
    headers: { accept: 'text/html;q=0.8, text/plain;q=0.4' },
    weights: { mediaType: 0 },
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.winner?.variant.id, 'A');
  assert.equal(r.winner?.score, 0.8);
});

/* ------------------------------------------------------------------ */
/* Not negotiable / invalid                                            */
/* ------------------------------------------------------------------ */

test('not-negotiable when every candidate is excluded', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/plain' }];
  const r = run(variants, { headers: { accept: 'text/plain;q=0' } });
  assert.equal(r.status, 'not-negotiable');
  assert.equal(r.winner, null);
});

test('not-negotiable when a dimension has no acceptable value for anyone', () => {
  const variants: V[] = [{ id: 'a', language: 'en' }, { id: 'b', language: 'de' }];
  const r = run(variants, { headers: { acceptLanguage: 'fr' } });
  assert.equal(r.status, 'not-negotiable');
  assert.ok(r.candidates.every((c) => c.eliminated));
});

test('empty variant list is not-negotiable', () => {
  const r = run([], { headers: { accept: 'text/html' } });
  assert.equal(r.status, 'not-negotiable');
});

test('malformed header -> invalid-request with per-dimension error', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/html' }];
  const r = run(variants, { headers: { accept: 'text/html;q=2', acceptLanguage: 'en' } });
  assert.equal(r.status, 'invalid-request');
  assert.equal(r.dimensions.mediaType.state, 'invalid');
  assert.match(r.dimensions.mediaType.error ?? '', /q value/);
  assert.equal(r.dimensions.language.state, 'present');
  assert.equal(r.winner, null);
  assert.deepEqual(r.candidates, []);
});

test('invalid variant metadata throws (server configuration error)', () => {
  assert.throws(() => negotiate([{ mediaType: 'text/*' }], { headers: {} }), TypeError);
  assert.throws(() => negotiate([{ language: 'en_US' }], { headers: {} }), TypeError);
  assert.throws(() => negotiate([{ encoding: '*' }], { headers: {} }), TypeError);
});

test('invalid weights throw', () => {
  assert.throws(() => negotiate([], { headers: {}, weights: { mediaType: -1 } }), TypeError);
  assert.throws(() => negotiate([], { headers: {}, weights: { language: Number.NaN } }), TypeError);
});

/* ------------------------------------------------------------------ */
/* Explainability of the report                                        */
/* ------------------------------------------------------------------ */

test('report exposes matched range, quality and elimination reason per dimension', () => {
  const variants: V[] = [
    { id: 'win', mediaType: 'text/html', language: 'en-US', encoding: 'gzip' },
    { id: 'lose', mediaType: 'application/json', language: 'fr', encoding: 'br' },
  ];
  const r = run(variants, {
    headers: {
      accept: 'application/json;q=0.4, text/html',
      acceptLanguage: 'en-US',
      acceptEncoding: 'gzip',
    },
  });
  assert.equal(r.status, 'ok');
  const win = r.candidates[0];
  assert.equal(win?.dimensions.mediaType.rangeRaw, 'text/html');
  assert.equal(win?.dimensions.mediaType.rangeIndex, 1);
  assert.equal(win?.dimensions.language.rangeRaw, 'en-US');
  assert.equal(win?.dimensions.encoding.rangeRaw, 'gzip');

  const lose = r.candidates[1];
  assert.equal(lose?.eliminated, true);
  assert.deepEqual(lose?.eliminationReasons, ['language:no-match', 'encoding:no-match']);
  assert.equal(lose?.dimensions.mediaType.quality, 0.4);
  assert.equal(lose?.dimensions.language.reason, 'no-match');
  assert.equal(lose?.score, null);

  // client ranges are reported in original order with normalized values
  assert.deepEqual(
    r.dimensions.mediaType.ranges.map((x) => [x.index, x.value, x.q]),
    [
      [0, 'application/json', 0.4],
      [1, 'text/html', 1],
    ],
  );
});

/* ------------------------------------------------------------------ */
/* Vary                                                                */
/* ------------------------------------------------------------------ */

test('vary contains only headers that participated', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/html', language: 'en' }];
  const r = run(variants, {
    headers: {
      accept: 'text/html, application/json',
      acceptLanguage: 'en',
      acceptEncoding: '*',
      // acceptCharset absent
    },
  });
  assert.deepEqual(r.vary, ['Accept', 'Accept-Language']);
});

test('pure wildcard with q=1 does not participate; with q<1 it does', () => {
  const variants: V[] = [{ id: 'a', mediaType: 'text/html' }];
  const pure = run(variants, { headers: { accept: '*/*' } });
  assert.deepEqual(pure.vary, []);
  const constrained = run(variants, { headers: { accept: '*/*;q=0.5' } });
  assert.deepEqual(constrained.vary, ['Accept']);
  const withExclusion = run(variants, { headers: { accept: '*/*, text/html;q=0' } });
  assert.deepEqual(withExclusion.vary, ['Accept']);
});

test('varyFor standalone agrees with negotiate and is conservative on invalid input', () => {
  assert.deepEqual(
    varyFor({ accept: 'text/html', acceptLanguage: 'en', acceptEncoding: '*', acceptCharset: 'utf-8' }),
    ['Accept', 'Accept-Language', 'Accept-Charset'],
  );
  assert.deepEqual(varyFor({}), []);
  assert.deepEqual(varyFor({ accept: '*/*' }), []);
  assert.deepEqual(varyFor({ accept: 'text/html;q=oops' }), ['Accept']);
});
