# accept-negotiation-core

Deterministic, explainable HTTP content negotiation as a pure library.
No server, no CLI, no HTTP parsing dependencies — just functions.

Given the four client preference headers (`Accept`, `Accept-Language`,
`Accept-Encoding`, `Accept-Charset`) and a list of server-side candidate
representations, it selects one candidate and tells you exactly why.

## Requirements

- Node.js 20+, TypeScript 5.5+
- Runtime dependencies: none

```sh
npm install        # dev dependencies only (typescript, @types/node)
npm test           # build + run the test suite
```

## API

```ts
import { negotiate, varyFor } from 'accept-negotiation-core';

const result = negotiate(variants, {
  headers: {
    accept: 'text/html;q=0.9, text/*;q=0.5, */*;q=0.1',
    acceptLanguage: 'en-US, en;q=0.8',
    acceptEncoding: 'gzip, br;q=0.8',
    acceptCharset: 'utf-8',
  },
  weights: { mediaType: 3, language: 2, encoding: 1, charset: 1 }, // optional, default 1
});
```

Each variant is your own object; the library only reads four optional keys
(`mediaType`, `language`, `encoding`, `charset`) and carries the rest through:

```ts
const variants = [
  { id: 'a', mediaType: 'text/html;level=1', language: 'en-US', encoding: 'gzip', charset: 'utf-8' },
  { id: 'b', mediaType: 'application/json', language: 'en' },
];
```

### Result

```ts
{
  status: 'ok' | 'not-negotiable' | 'invalid-request',
  winner: { index, variant, score } | null,
  dimensions: {           // fixed keys, always all four
    mediaType:  { header, state, weight, participated, ranges, error? },
    language:   { ... },
    encoding:   { ... },
    charset:    { ... },
  },
  candidates: [{          // in server (input) order
    index, variant, eliminated, eliminationReasons, score,
    dimensions: {
      mediaType: { participated, matched, rangeIndex, rangeRaw, quality, specificity, reason?, note? },
      ...
    },
  }],
  vary: ['Accept', 'Accept-Language', ...],
}
```

- `dimensions.<dim>.state` distinguishes **`absent`** (header missing — the
  dimension does not constrain anything) from **`present`** (which includes an
  explicit `*`) and **`invalid`** (malformed header).
- Per candidate and dimension you get the matched client range (`rangeIndex`
  into the reported `ranges`, `rangeRaw` as the original text), the `quality`
  (0..1), the specificity vector, and the elimination `reason`
  (`no-match` / `q-zero`).
- `varyFor(headers)` computes the same `vary` set without running a full
  negotiation. Only headers that actually constrained the selection are
  included; a header that is just a bare wildcard with `q=1` (e.g.
  `Accept: */*`) does not participate and is excluded.

## Rules

### Parsing (strict)

- Original element order is preserved (`index` on every range).
- Case is normalized where the RFCs define values as case-insensitive
  (type/subtype, parameter names including `q`, language tags, codings,
  charsets). Parameter *values* remain case-sensitive.
- Optional whitespace (SP/TAB) is allowed around `,`, `;`, `=` only.
- Duplicate parameter names (case-insensitive, including duplicate `q`) are
  rejected. Media-type parameters before `q` must have values; parameters
  after `q` are accept-extensions and may be bare tokens.
- q values must be `0`–`1` with at most 3 decimals (`q=1.0000`, `q=.5`,
  `q=2`, quoted q values are all rejected). Internally q is an exact integer
  in thousandths.
- Empty header values, empty list elements, and stray characters reject the
  whole header → `status: 'invalid-request'`. Malformed *variant* metadata is
  a server configuration error and throws `TypeError`.

### Matching

- **Media types**: `type/*` and `*/*` wildcards; client-range parameters must
  be a subset of the variant's parameters. Specificity is
  `[wildcard-level, parameter-count]`; the most specific matching range
  determines the quality.
- **Languages**: RFC 4647 basic filtering — a range matches a tag if it is a
  prefix on a subtag boundary (`en` matches `en-US`, not vice versa). Longer
  ranges are more specific. `*` matches anything, including untagged variants.
- **Encodings**: exact match beats `*`. `identity` (a variant without
  `encoding`) is acceptable by default when the header lists neither
  `identity` nor `*`; `identity;q=0` or `*;q=0` excludes it.
- **Charsets**: exact match beats `*`; no implicit defaults.
- `q=0` always eliminates, even if a wildcard also matches.

### Selection

1. A candidate is eliminated if any participating dimension has quality 0 or
   no matching range. If no candidate survives → `not-negotiable`.
2. Survivors are scored `Σ w_d·q_d / Σ w_d` over participating dimensions
   (absent headers contribute no weight; all-zero weights fall back to equal).
3. Ties break by: specificity vector → matched client-range positions →
   server-side candidate order. All comparisons run over the fixed dimension
   order `mediaType, language, encoding, charset`; nothing depends on object
   key iteration order.

## Tests

- `test/parse.test.ts` — table-driven parser cases (valid + invalid).
- `test/negotiate.test.ts` — table-driven negotiation scenarios.
- `test/property.test.ts` — seeded random cases (mulberry32, fixed seeds)
  checking, among other invariants, that results are byte-identical across
  runs, insensitive to object key order, and that candidate input order only
  matters through the documented final tie-break.
