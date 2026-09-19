import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigurationError,
  NegotiationSyntaxError,
  computeVary,
  negotiate,
  type Candidate,
  type NegotiationResult,
} from '../src/index.js';

function selectedId(result: NegotiationResult<{ id: string }>): string {
  assert.ok(result.ok, 'expected negotiation to succeed');
  return result.selected.candidate.data!.id;
}

// ---------------------------------------------------------------------------
// Media dimension
// ---------------------------------------------------------------------------

test('media: exact match wins', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'html' } },
      { mediaType: 'application/json', data: { id: 'json' } },
    ],
    { accept: 'application/json' },
  );
  assert.equal(selectedId(result), 'json');
  assert.ok(result.ok);
  assert.equal(result.selected.dimensions[0].matchedRange, 'application/json');
  assert.equal(result.selected.dimensions[0].quality, 1);
  assert.deepEqual(result.vary, ['Accept']);
});

test('media: exact range beats type wildcard regardless of client order', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'html' } },
      { mediaType: 'text/plain', data: { id: 'plain' } },
    ],
    { accept: 'text/*;q=0.5, text/html' },
  );
  assert.ok(result.ok);
  const [html, plain] = result.reports;
  assert.equal(html!.dimensions[0].quality, 1);
  assert.equal(html!.dimensions[0].matchedRange, 'text/html');
  assert.equal(plain!.dimensions[0].quality, 0.5);
  assert.equal(plain!.dimensions[0].matchedRange, 'text/*;q=0.5');
  assert.equal(selectedId(result), 'html');
});

test('media: q=0 on the most specific range excludes, less specific still applies', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'html' } },
      { mediaType: 'text/plain', data: { id: 'plain' } },
    ],
    { accept: 'text/html;q=0, text/*;q=0.5' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'plain');
  const [html] = result.reports;
  assert.ok(html!.eliminated);
  assert.equal(html!.dimensions[0].state, 'excluded');
  assert.match(html!.eliminationReasons[0]!, /q=0/);
});

test('media: parameters must match the candidate and add specificity', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html;level=1', data: { id: 'with-param' } },
      { mediaType: 'text/html', data: { id: 'plain' } },
    ],
    { accept: 'text/html;level=1, text/html;q=0.8' },
  );
  assert.ok(result.ok);
  const [withParam, plain] = result.reports;
  assert.equal(withParam!.dimensions[0].quality, 1);
  assert.equal(withParam!.dimensions[0].specificity, 3); // exact (2) + 1 param
  assert.equal(plain!.dimensions[0].quality, 0.8); // first range does not match: level=1 missing
  assert.equal(plain!.dimensions[0].matchedRange, 'text/html;q=0.8');
  assert.equal(selectedId(result), 'with-param');
});

test('media: parameter value mismatch falls back to a less specific range', () => {
  const result = negotiate(
    [{ mediaType: 'text/html;level=2', data: { id: 'two' } }],
    { accept: 'text/html;level=1;q=0.9, text/html;q=0.3' },
  );
  assert.ok(result.ok);
  assert.equal(result.selected.dimensions[0].quality, 0.3);
  assert.equal(result.selected.dimensions[0].matchedRange, 'text/html;q=0.3');
});

test('media: parameter names and values compare case-insensitively', () => {
  const result = negotiate(
    [{ mediaType: 'text/html;Level=1', data: { id: 'x' } }],
    { accept: 'TEXT/HTML;LEVEL=1' },
  );
  assert.ok(result.ok);
  assert.equal(result.selected.dimensions[0].specificity, 3);
});

test('media: empty Accept header excludes everything', () => {
  const result = negotiate([{ mediaType: 'text/html', data: { id: 'x' } }], { accept: '' });
  assert.ok(!result.ok);
  assert.equal(result.failure, 'all-candidates-excluded');
  assert.match(result.reports[0]!.dimensions[0].reason, /empty/);
});

// ---------------------------------------------------------------------------
// Language dimension
// ---------------------------------------------------------------------------

test('language: prefix truncation matches, ties fall back to server order', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', language: 'en-US', data: { id: 'us' } },
      { mediaType: 'text/html', language: 'en', data: { id: 'en' } },
      { mediaType: 'text/html', language: 'fr', data: { id: 'fr' } },
    ],
    { acceptLanguage: 'en' },
  );
  assert.ok(result.ok);
  assert.ok(result.reports[2]!.eliminated);
  assert.equal(result.reports[0]!.dimensions[1].matchedRange, 'en');
  assert.equal(result.reports[0]!.dimensions[1].specificity, 1);
  assert.equal(selectedId(result), 'us'); // tie with 'en' -> server order
});

test('language: a longer range does not match a shorter tag', () => {
  const result = negotiate(
    [{ mediaType: 'text/html', language: 'en', data: { id: 'en' } }],
    { acceptLanguage: 'en-US' },
  );
  assert.ok(!result.ok);
  assert.equal(result.failure, 'all-candidates-excluded');
});

test('language: more specific range overrides q=0 of a shorter range', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', language: 'en-US', data: { id: 'us' } },
      { mediaType: 'text/html', language: 'en-GB', data: { id: 'gb' } },
    ],
    { acceptLanguage: 'en;q=0, en-US;q=1' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'us');
  assert.ok(result.reports[1]!.eliminated);
  assert.equal(result.reports[1]!.dimensions[1].state, 'excluded');
});

test('language: candidate without language is neutral, explicit match wins on specificity', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'neutral' } },
      { mediaType: 'text/html', language: 'en', data: { id: 'en' } },
    ],
    { acceptLanguage: 'en' },
  );
  assert.ok(result.ok);
  assert.equal(result.reports[0]!.dimensions[1].state, 'not-applicable');
  assert.equal(result.reports[0]!.dimensions[1].quality, 1);
  assert.equal(selectedId(result), 'en'); // same score, higher specificity
});

// ---------------------------------------------------------------------------
// Encoding dimension
// ---------------------------------------------------------------------------

test('encoding: identity is acceptable by default; explicit match wins on specificity', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'identity' } },
      { mediaType: 'text/html', encoding: 'gzip', data: { id: 'gzip' } },
    ],
    { acceptEncoding: 'gzip' },
  );
  assert.ok(result.ok);
  const [identity] = result.reports;
  assert.equal(identity!.dimensions[2].state, 'matched');
  assert.equal(identity!.dimensions[2].matchedRange, null);
  assert.match(identity!.dimensions[2].reason, /by default/);
  assert.equal(selectedId(result), 'gzip');
});

test('encoding: identity;q=0 excludes the identity candidate', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'identity' } },
      { mediaType: 'text/html', encoding: 'gzip', data: { id: 'gzip' } },
    ],
    { acceptEncoding: 'gzip, identity;q=0' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'gzip');
  assert.ok(result.reports[0]!.eliminated);
});

test('encoding: *;q=0 excludes identity unless identity is listed explicitly', () => {
  const excluded = negotiate(
    [{ mediaType: 'text/html', data: { id: 'identity' } }],
    { acceptEncoding: 'gzip, *;q=0' },
  );
  assert.ok(!excluded.ok);

  const rescued = negotiate(
    [{ mediaType: 'text/html', data: { id: 'identity' } }],
    { acceptEncoding: '*;q=0, identity;q=0.5' },
  );
  assert.ok(rescued.ok);
  assert.equal(rescued.selected.dimensions[2].quality, 0.5);
  assert.equal(rescued.selected.dimensions[2].matchedRange, 'identity;q=0.5');
});

test('encoding: unlisted coding without star is excluded', () => {
  const result = negotiate(
    [{ mediaType: 'text/html', encoding: 'gzip', data: { id: 'gzip' } }],
    { acceptEncoding: 'br' },
  );
  assert.ok(!result.ok);
  assert.match(result.reports[0]!.dimensions[2].reason, /not listed/);
});

test('encoding: empty Accept-Encoding means identity only', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'identity' } },
      { mediaType: 'text/html', encoding: 'gzip', data: { id: 'gzip' } },
    ],
    { acceptEncoding: '' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'identity');
  assert.ok(result.reports[1]!.eliminated);
});

// ---------------------------------------------------------------------------
// Charset dimension
// ---------------------------------------------------------------------------

test('charset: explicit match beats neutral candidate on specificity', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', charset: 'utf-8', data: { id: 'utf8' } },
      { mediaType: 'text/html', data: { id: 'neutral' } },
    ],
    { acceptCharset: 'utf-8' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'utf8');
  assert.equal(result.reports[1]!.dimensions[3].state, 'not-applicable');
  assert.deepEqual(result.vary, ['Accept-Charset']);
});

test('charset: unlisted charset is excluded, neutral candidate survives', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', charset: 'utf-8', data: { id: 'utf8' } },
      { mediaType: 'text/html', data: { id: 'neutral' } },
    ],
    { acceptCharset: 'iso-8859-1' },
  );
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'neutral');
  assert.ok(result.reports[0]!.eliminated);
});

// ---------------------------------------------------------------------------
// Missing header vs explicit star
// ---------------------------------------------------------------------------

test('missing header and explicit star are distinct states', () => {
  const candidates: Candidate<{ id: string }>[] = [{ mediaType: 'text/html', data: { id: 'x' } }];

  const missing = negotiate(candidates, {});
  assert.ok(missing.ok);
  assert.equal(missing.selected.dimensions[0].state, 'header-missing');
  assert.equal(missing.selected.dimensions[0].matchedRange, null);
  assert.deepEqual(missing.vary, []);

  const starred = negotiate(candidates, { accept: '*/*' });
  assert.ok(starred.ok);
  assert.equal(starred.selected.dimensions[0].state, 'matched');
  assert.equal(starred.selected.dimensions[0].matchedRange, '*/*');
  assert.deepEqual(starred.vary, ['Accept']);
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test('all candidates excluded -> not negotiable, with per-dimension counts', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'a' } },
      { mediaType: 'application/json', data: { id: 'b' } },
    ],
    { accept: 'image/png' },
  );
  assert.ok(!result.ok);
  assert.equal(result.failure, 'all-candidates-excluded');
  assert.deepEqual(result.eliminatedCounts, { media: 2, language: 0, encoding: 0, charset: 0 });
  assert.ok(result.reports.every((r) => r.eliminated));
});

test('no candidates -> no-candidates failure', () => {
  const result = negotiate<{ id: string }>([], { accept: 'text/html' });
  assert.ok(!result.ok);
  assert.equal(result.failure, 'no-candidates');
  assert.deepEqual(result.reports, []);
  assert.deepEqual(result.vary, ['Accept']);
});

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

test('weights: dimension weights change the combined score and the winner', () => {
  const candidates: Candidate<{ id: string }>[] = [
    { mediaType: 'text/html', data: { id: 'html-nolang' } },
    { mediaType: 'text/plain', language: 'fr', data: { id: 'plain-fr' } },
  ];
  const request = { accept: 'text/html;q=0.9, text/plain', acceptLanguage: 'fr;q=0.4' };

  const languageHeavy = negotiate(candidates, request, { weights: { language: 10 } });
  assert.equal(selectedId(languageHeavy), 'html-nolang');

  const mediaHeavy = negotiate(candidates, request, { weights: { language: 0.1 } });
  assert.equal(selectedId(mediaHeavy), 'plain-fr');

  // score is a weighted average in [0, 1]
  assert.ok(languageHeavy.ok);
  const [a, b] = languageHeavy.reports;
  assert.ok(Math.abs(a!.score - (0.9 + 10 + 1 + 1) / 13) < 1e-12);
  assert.ok(Math.abs(b!.score - (1 + 4 + 1 + 1) / 13) < 1e-12);
});

// ---------------------------------------------------------------------------
// Tie-breaking
// ---------------------------------------------------------------------------

test('tie-break: client order decides after quality and specificity', () => {
  const candidates: Candidate<{ id: string }>[] = [
    { mediaType: 'text/html', data: { id: 'html' } },
    { mediaType: 'application/json', data: { id: 'json' } },
  ];
  assert.equal(selectedId(negotiate(candidates, { accept: 'text/html, application/json' })), 'html');
  assert.equal(selectedId(negotiate(candidates, { accept: 'application/json, text/html' })), 'json');
});

test('tie-break: server order is the final decider', () => {
  const result = negotiate(
    [
      { mediaType: 'text/html', data: { id: 'first' } },
      { mediaType: 'text/html', data: { id: 'second' } },
    ],
    { accept: 'text/html' },
  );
  assert.equal(selectedId(result), 'first');
});

// ---------------------------------------------------------------------------
// Vary
// ---------------------------------------------------------------------------

test('vary: only headers that participated in selection', () => {
  // language header present but no candidate declares a language -> not in Vary
  const noLang = negotiate([{ mediaType: 'text/html', data: { id: 'x' } }], { acceptLanguage: 'en' });
  assert.deepEqual(noLang.vary, []);

  const withLang = negotiate([{ mediaType: 'text/html', language: 'en', data: { id: 'x' } }], {
    acceptLanguage: 'en',
  });
  assert.deepEqual(withLang.vary, ['Accept-Language']);

  const full = negotiate(
    [{ mediaType: 'text/html', language: 'en', charset: 'utf-8', data: { id: 'x' } }],
    { accept: 'text/html', acceptLanguage: 'en', acceptEncoding: 'gzip', acceptCharset: 'utf-8' },
  );
  assert.deepEqual(full.vary, ['Accept', 'Accept-Language', 'Accept-Encoding', 'Accept-Charset']);
});

test('computeVary matches the vary reported by negotiate', () => {
  const candidates: Candidate[] = [
    { mediaType: 'text/html', language: 'en' },
    { mediaType: 'text/plain', charset: 'utf-8' },
  ];
  const request = { accept: 'text/html', acceptLanguage: 'en', acceptCharset: 'utf-8' };
  assert.deepEqual(computeVary(candidates, request), negotiate(candidates, request).vary);
});

// ---------------------------------------------------------------------------
// Explanation reports
// ---------------------------------------------------------------------------

test('reports explain the selected candidate per dimension', () => {
  const result = negotiate(
    [{ mediaType: 'text/html', language: 'en-US', charset: 'utf-8', data: { id: 'x' } }],
    { accept: 'text/*;q=0.7', acceptLanguage: 'en', acceptCharset: '*' },
  );
  assert.ok(result.ok);
  const [media, language, encoding, charset] = result.selected.dimensions;
  assert.equal(media.dimension, 'media');
  assert.equal(media.matchedRange, 'text/*;q=0.7');
  assert.equal(media.matchedRangeIndex, 0);
  assert.equal(media.quality, 0.7);
  assert.equal(media.specificity, 1);
  assert.equal(language.matchedRange, 'en');
  assert.equal(language.specificity, 1);
  assert.equal(encoding.state, 'header-missing');
  assert.equal(encoding.headerPresent, false);
  assert.equal(charset.matchedRange, '*');
  assert.equal(charset.specificity, 0);
  assert.equal(charset.state, 'matched'); // explicit star, NOT header-missing
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('malformed request headers raise NegotiationSyntaxError', () => {
  assert.throws(
    () => negotiate([{ mediaType: 'text/html' }], { accept: 'not a type' }),
    NegotiationSyntaxError,
  );
  assert.throws(
    () => negotiate([{ mediaType: 'text/html' }], { acceptLanguage: 'en-' }),
    NegotiationSyntaxError,
  );
  assert.throws(
    () => negotiate([{ mediaType: 'text/html' }], { acceptCharset: '' }),
    NegotiationSyntaxError,
  );
});

test('invalid candidates are rejected', () => {
  assert.throws(() => negotiate([{ mediaType: 'text/*' }], {}), NegotiationSyntaxError);
  assert.throws(() => negotiate([{ mediaType: 'text' }], {}), NegotiationSyntaxError);
  assert.throws(() => negotiate([{ mediaType: 'text/html', language: 'en-' }], {}), NegotiationSyntaxError);
  assert.throws(() => negotiate([{ mediaType: 'text/html', encoding: '*' }], {}), NegotiationSyntaxError);
  assert.throws(() => negotiate([{ mediaType: 'text/html', charset: '*' }], {}), NegotiationSyntaxError);
  // @ts-expect-error mediaType is required
  assert.throws(() => negotiate([{}], {}), Error);
});

test('invalid weights are rejected', () => {
  const candidates: Candidate[] = [{ mediaType: 'text/html' }];
  assert.throws(() => negotiate(candidates, {}, { weights: { media: -1 } }), ConfigurationError);
  assert.throws(() => negotiate(candidates, {}, { weights: { media: Number.NaN } }), ConfigurationError);
  assert.throws(
    () => negotiate(candidates, {}, { weights: { media: 0, language: 0, encoding: 0, charset: 0 } }),
    ConfigurationError,
  );
});

test('weight 0 dimension still excludes on q=0 but does not contribute to the score', () => {
  const candidates: Candidate<{ id: string }>[] = [
    { mediaType: 'text/html', language: 'en', data: { id: 'en' } },
    { mediaType: 'text/html', language: 'fr', data: { id: 'fr' } },
  ];
  const result = negotiate(candidates, { acceptLanguage: 'en;q=0, fr;q=0.5' }, { weights: { language: 0 } });
  assert.ok(result.ok);
  assert.equal(selectedId(result), 'fr'); // 'en' still eliminated by q=0
  assert.equal(result.selected.score, 1); // language contributes nothing
});
