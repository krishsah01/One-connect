// SPDX-License-Identifier: Apache-2.0
// Read bounded codeload tarballs in memory; never extract paths or execute imported files.
import { gunzipSync } from 'node:zlib';
import { CommandError } from '../daemon.ts';
export const ARCHIVE_LIMITS = { compressedBytes: 8 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, files: 2048, fileBytes: 512 * 1024 } as const;
function safePath(s: string): string {
  if (!s || s.length > 500 || s.startsWith('/') || s.includes('\\') || s.includes('\0') || s.split('/').some(p => !p || p === '.' || p === '..')) throw new CommandError('Archive contains an unsafe path');
  return s;
}
function field(block: Buffer, start: number, end: number): string { return block.subarray(start, end).toString('utf8').split('\0')[0]; }
function octal(s: string): number { if (!/^[0-7]+$/.test(s.trim())) throw new CommandError('Invalid tar size or checksum'); return parseInt(s.trim(), 8); }
function pax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}; let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(32, offset); if (space < 0) throw new CommandError('Invalid tar metadata');
    const size = Number(body.subarray(offset, space).toString());
    if (!Number.isSafeInteger(size) || size < 5 || offset + size > body.length) throw new CommandError('Invalid tar metadata');
    const row = body.subarray(space + 1, offset + size - 1).toString('utf8'), eq = row.indexOf('=');
    if (eq < 1) throw new CommandError('Invalid tar metadata'); out[row.slice(0, eq)] = row.slice(eq + 1); offset += size;
  }
  return out;
}
export function readTarGzip(compressed: Buffer): Map<string, Buffer> {
  if (compressed.length > ARCHIVE_LIMITS.compressedBytes) throw new CommandError('Archive is too large', 413);
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: ARCHIVE_LIMITS.expandedBytes }); } catch { throw new CommandError('Invalid or oversized compressed archive', 413); }
  const files = new Map<string, Buffer>(); let root: string | null = null; let count = 0; let extended: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(b => b === 0)) return files;
    if (++count > ARCHIVE_LIMITS.files) throw new CommandError('Archive has too many entries', 413);
    const expected = octal(field(header, 148, 156));
    const actual = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (expected !== actual) throw new CommandError('Invalid tar checksum');
    const size = octal(field(header, 124, 136)), type = field(header, 156, 157) || '0';
    if (size > ARCHIVE_LIMITS.fileBytes || offset + 512 + size > tar.length) throw new CommandError('Archive file exceeds bounds', 413);
    const body = tar.subarray(offset + 512, offset + 512 + size); offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') { const meta = pax(body); if (meta.linkpath || meta.size) throw new CommandError('Unsupported tar metadata'); if (type === 'x') extended = meta; continue; }
    if (type !== '0' && type !== '5') throw new CommandError('Archive links and special files are not allowed');
    const prefix = field(header, 345, 500), name = extended.path ?? (prefix ? prefix + '/' : '') + field(header, 0, 100); extended = {};
    const full = safePath(name.replace(/\/$/, '')), segments = full.split('/');
    root ??= segments[0]; if (root !== segments[0]) throw new CommandError('Archive must have a single repository root');
    if (type === '5') continue;
    const relative = segments.slice(1).join('/'); safePath(relative);
    if (files.has(relative)) throw new CommandError('Duplicate archive path'); files.set(relative, Buffer.from(body));
  }
  throw new CommandError('Archive is truncated');
}
