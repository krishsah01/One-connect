// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared helpers every package relies on: adapter profiles, canonical JSON and text shaping.
import { describe, expect, it } from 'vitest';
import { ADAPTER_PROFILES, ADAPTER_TYPES, canonicalJson, clip, ellipsize, isManualRelay, shellJoin, shellQuote } from '../src/index.ts';

describe('adapter profiles', () => {
  it('describe every adapter type, and only relay is run by hand', () => {
    expect(Object.keys(ADAPTER_PROFILES).sort()).toEqual([...ADAPTER_TYPES].sort());
    expect(ADAPTER_TYPES.filter((adapter) => isManualRelay({ adapter }))).toEqual(['relay']);
    for (const type of ADAPTER_TYPES) {
      const p = ADAPTER_PROFILES[type];
      // A runtime with a login command must be one that runs here.
      if (p.loginArgs) expect(p.runsHere).toBe(true);
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys by code unit at every depth, independent of insertion order and locale', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, B: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"B":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
  });
});

describe('text helpers', () => {
  it('shortens with or without a count of what was cut', () => {
    expect(ellipsize('abcdef', 4)).toBe('abc…');
    expect(ellipsize('abc', 4)).toBe('abc');
    expect(clip('abcdef', 2)).toBe('ab… [4 more chars]');
  });

  it('quotes shell words safely and only when needed', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellJoin(['git', 'commit', '-m', 'a b'])).toBe(`git commit -m 'a b'`);
  });
});
