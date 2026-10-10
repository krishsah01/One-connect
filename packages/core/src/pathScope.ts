// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Path-scope globs for assignments: `src/**`, `docs/*.md`, `package.json`.

export function scopeGlobToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function inScope(path: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true; // no scope configured = whole repo
  const p = path.replace(/^\.\//, '');
  return allowed.some((g) => scopeGlobToRegExp(g).test(p));
}

export function outOfScope(paths: readonly string[], allowed: readonly string[], ignore: readonly string[] = []): string[] {
  return paths.filter((p) => !inScope(p, allowed) && !ignore.some((g) => scopeGlobToRegExp(g).test(p)));
}

/** Literal directory prefix before the first wildcard: `src/auth/**` → `src/auth/`. */
function literalPrefix(glob: string): string {
  const g = glob.trim().replace(/^\.\//, '');
  const i = g.search(/[*?[]/);
  return i < 0 ? g : g.slice(0, i);
}

/**
 * Conservative overlap test between two scopes: true if some path could match both.
 * Empty scope means "whole repo", which overlaps everything.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const x of a) {
    for (const y of b) {
      const px = literalPrefix(x);
      const py = literalPrefix(y);
      const xWild = px.length !== x.trim().replace(/^\.\//, '').length;
      const yWild = py.length !== y.trim().replace(/^\.\//, '').length;
      if (!xWild && !yWild) {
        if (px === py) return true;
        continue;
      }
      if (!xWild) {
        if (scopeGlobToRegExp(y).test(px)) return true;
        continue;
      }
      if (!yWild) {
        if (scopeGlobToRegExp(x).test(py)) return true;
        continue;
      }
      if (px.startsWith(py) || py.startsWith(px)) return true;
    }
  }
  return false;
}
