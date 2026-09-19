/**
 * Deterministic random generators for property-style tests.
 * No external dependencies; mulberry32 PRNG with explicit seeds.
 */

import type { RequestHeaders, Variant, WeightConfig } from '../src/index.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from empty array');
  return items[Math.floor(rng() * items.length)] as T;
}

export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const Q_CHOICES = [undefined, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;

function qSuffix(rng: () => number): string {
  const q = pick(rng, Q_CHOICES);
  return q === undefined ? '' : `;q=${q}`;
}

const MEDIA_PARAM_POOL: ReadonlyArray<readonly [string, string]> = [
  ['level', '1'],
  ['level', '2'],
  ['version', '3'],
  ['charset', 'utf-8'],
];

function mediaParams(rng: () => number): string {
  const used = new Set<string>();
  let out = '';
  const n = randInt(rng, 0, 2);
  for (let i = 0; i < n; i++) {
    const [name, value] = pick(rng, MEDIA_PARAM_POOL);
    if (used.has(name)) continue;
    used.add(name);
    out += `;${name}=${value}`;
  }
  return out;
}

const RANGE_TYPES = ['text', 'application', 'image', '*'] as const;
const RANGE_SUBTYPES = ['html', 'plain', 'json', 'png', '*'] as const;

function mediaRange(rng: () => number): string {
  const type = pick(rng, RANGE_TYPES);
  const subtype = type === '*' ? '*' : pick(rng, RANGE_SUBTYPES);
  return `${type}/${subtype}${mediaParams(rng)}${qSuffix(rng)}`;
}

const LANGUAGE_RANGES = ['en', 'en-us', 'en-gb', 'fr', 'fr-ca', 'de', 'zh-hans', '*'] as const;
const ENCODINGS = ['gzip', 'br', 'identity', 'deflate', '*'] as const;
const CHARSETS = ['utf-8', 'utf-16', 'iso-8859-1', '*'] as const;

function tokenRange(rng: () => number, pool: readonly string[]): string {
  return `${pick(rng, pool)}${qSuffix(rng)}`;
}

function listOf(rng: () => number, element: () => string): string {
  const n = randInt(rng, 1, 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(element());
  return parts.join(', ');
}

export function genHeaders(rng: () => number): RequestHeaders {
  const headers: {
    accept?: string;
    acceptLanguage?: string;
    acceptEncoding?: string;
    acceptCharset?: string;
  } = {};
  if (chance(rng, 0.7)) headers.accept = listOf(rng, () => mediaRange(rng));
  if (chance(rng, 0.7)) headers.acceptLanguage = listOf(rng, () => tokenRange(rng, LANGUAGE_RANGES));
  if (chance(rng, 0.7)) headers.acceptEncoding = listOf(rng, () => tokenRange(rng, ENCODINGS));
  if (chance(rng, 0.7)) headers.acceptCharset = listOf(rng, () => tokenRange(rng, CHARSETS));
  return headers;
}

export interface GenVariant extends Variant {
  readonly id: number;
}

const VARIANT_TYPES = ['text', 'application', 'image'] as const;
const VARIANT_SUBTYPES = ['html', 'plain', 'json', 'png'] as const;
const VARIANT_LANGUAGES = ['en', 'en-US', 'en-GB', 'fr', 'fr-CA', 'de', 'zh-Hans', 'es'] as const;
const VARIANT_ENCODINGS = ['gzip', 'br', 'deflate', 'identity'] as const;
const VARIANT_CHARSETS = ['utf-8', 'utf-16', 'iso-8859-1'] as const;

export function genVariants(rng: () => number): GenVariant[] {
  const n = randInt(rng, 1, 8);
  const out: GenVariant[] = [];
  for (let i = 0; i < n; i++) {
    const v: { id: number; mediaType?: string; language?: string; encoding?: string; charset?: string } = { id: i };
    if (chance(rng, 0.7)) {
      v.mediaType = `${pick(rng, VARIANT_TYPES)}/${pick(rng, VARIANT_SUBTYPES)}${mediaParams(rng)}`;
    }
    if (chance(rng, 0.7)) v.language = pick(rng, VARIANT_LANGUAGES);
    if (chance(rng, 0.6)) v.encoding = pick(rng, VARIANT_ENCODINGS);
    if (chance(rng, 0.6)) v.charset = pick(rng, VARIANT_CHARSETS);
    out.push(v);
  }
  return out;
}

const WEIGHT_CHOICES = [0, 0.5, 1, 2, 3] as const;

export function genWeights(rng: () => number): WeightConfig {
  const w: { mediaType?: number; language?: number; encoding?: number; charset?: number } = {};
  if (chance(rng, 0.6)) w.mediaType = pick(rng, WEIGHT_CHOICES);
  if (chance(rng, 0.6)) w.language = pick(rng, WEIGHT_CHOICES);
  if (chance(rng, 0.6)) w.encoding = pick(rng, WEIGHT_CHOICES);
  if (chance(rng, 0.6)) w.charset = pick(rng, WEIGHT_CHOICES);
  return w;
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
