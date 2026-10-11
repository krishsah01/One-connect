// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import YAML from 'yaml';
import { containsSecret, SKILL_REFERENCE_RE, type SkillDraft } from '@acc/core';
import { CommandError } from '../errors.ts';
import { previewSkillImport } from '../skillImport.ts';
import { ARCHIVE_LIMITS, readTarGzip } from './archive.ts';
import { jsonResponse, readBounded, shaPattern, type MarketplaceFetch } from './transport.ts';
import { sha256 } from '../util/hash.ts';
export interface GitHubSource { url: string; repo: string; ref: string | null; path: string }
export function githubSource(raw: unknown): GitHubSource {
  if (typeof raw !== 'string' || raw.length > 500) throw new CommandError('Enter a GitHub HTTPS repository URL');
  let url: URL; try { url = new URL(raw); } catch { throw new CommandError('Invalid GitHub URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new CommandError('Use https://github.com without credentials, query or fragment');
  let parts: string[]; try { parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent); } catch { throw new CommandError('Invalid URL encoding'); }
  if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || /[/\\\0]/.test(p)) || !parts.slice(0,2).every(p => /^[a-zA-Z0-9_.-]+$/.test(p))) throw new CommandError('Invalid GitHub repository or path');
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`; let ref: string | null = null; let path = '';
  if (parts.length > 2) { if (!['tree', 'blob'].includes(parts[2]) || parts.length < 4) throw new CommandError('Use a repository URL or a GitHub tree/blob path'); ref = parts[3]; path = parts.slice(4).join('/'); if (parts[2] === 'blob' && path.endsWith('/SKILL.md')) path = path.slice(0,-9); else if (path === 'SKILL.md') path = ''; }
  return { url: url.href.replace(/\/$/, ''), repo, ref, path };
}
export interface MarketplaceSkill {
  name: string; description: string; path: string; sha256: string;
  files: { path: string; sha256: string; bytes: number }[];
  draft: SkillDraft | null; problems: string[]; omittedMetadata: string[];
}
export interface GitHubPreview { url: string; repo: string; commit: string; license: string | null; licenseSha256: string | null; licensePath: string | null; licenseText: string | null; archiveSha256: string; skills: MarketplaceSkill[]; untrusted: true }
function text(b: Buffer): string { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { throw new CommandError('Skill text must be UTF-8'); } }
function detectLicense(body: string): string | null {
  if (/Apache License/i.test(body) && /Version 2\.0/.test(body)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/.test(body)) return 'MIT';
  if (/GNU GENERAL PUBLIC LICENSE/.test(body) && /Version 3/.test(body)) return 'GPL-3.0-only';
  if (/BSD/.test(body) && /Neither the name/.test(body)) return 'BSD-3-Clause';
  return null;
}
export async function githubPreview(rawUrl: unknown, fetcher: MarketplaceFetch, denylist: string[] = [], pinnedCommit?: string): Promise<GitHubPreview> {
  const src = githubSource(rawUrl);
  if (containsSecret(src.url, { denylist }).length) throw new CommandError('Remove credentials from the source URL');
  let commit = pinnedCommit;
  if (!commit) {
    const repo = await jsonResponse(fetcher, `https://api.github.com/repos/${src.repo}`, 128000) as { default_branch?: unknown };
    const ref = src.ref ?? repo?.default_branch;
    if (typeof ref !== 'string' || !ref || ref.length > 200) throw new CommandError('GitHub did not report a branch');
    const resolved = await jsonResponse(fetcher, `https://api.github.com/repos/${src.repo}/commits/${encodeURIComponent(ref)}`, 128000) as { sha?: unknown };
    if (typeof resolved?.sha !== 'string') throw new CommandError('GitHub did not report a commit'); commit = resolved.sha;
  }
  if (!shaPattern.test(commit)) throw new CommandError('A full 40-character commit SHA is required');
  const archive = await readBounded(await fetcher(`https://codeload.github.com/${src.repo}/tar.gz/${commit}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) }), ARCHIVE_LIMITS.compressedBytes);
  const files = readTarGzip(archive), licenseEntry = [...files].find(([p]) => /^(?:LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(p));
  const licenseText = licenseEntry ? text(licenseEntry[1]) : '';
  if (licenseText.length > 20000) throw new CommandError('License preview exceeds 20000 characters', 413);
  if (containsSecret(licenseText, { denylist }).length) throw new CommandError('Repository license contains credentials');
  const license = detectLicense(licenseText);
  const skills: MarketplaceSkill[] = [];
  for (const [filePath, content] of files) {
    if (!(filePath === 'SKILL.md' || filePath.endsWith('/SKILL.md')) || (src.path && !filePath.startsWith(src.path + '/'))) continue;
    if (skills.length >= 64) throw new CommandError('Marketplace catalog exceeds 64 skills', 413);
    const directory = filePath === 'SKILL.md' ? '' : filePath.slice(0, -9), prefix = directory ? directory + '/' : '';
    const nested = [...files.keys()].filter(p => p !== filePath && p.endsWith('/SKILL.md') && p.startsWith(prefix)).map(p => p.slice(0,-8));
    const skillFiles = [...files].filter(([p]) => p === filePath || (p.startsWith(prefix) && !nested.some(dir => p.startsWith(dir))));
    const manifest = skillFiles.map(([p,b]) => ({ path: p, sha256: sha256(b), bytes: b.length }));
    if (manifest.reduce((n,f) => n + f.bytes, 0) > 512000) throw new CommandError('Skill exceeds aggregate byte limits', 413);
    const original = text(content);
    if (containsSecret(original, { denylist }).length) throw new CommandError('Skill contains credentials; import refused');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(original);
    const row: MarketplaceSkill = { path: filePath, sha256: sha256(content), name: directory.split('/').at(-1) ?? 'skill', description: '', files: manifest, draft: null, problems: [], omittedMetadata: [] };
    try {
      if (!match) throw new CommandError('Skill needs YAML frontmatter');
      const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
      if (doc.errors.length || !YAML.isMap(doc.contents)) throw new CommandError('Invalid skill frontmatter');
      const metadata = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      if (typeof metadata.name !== 'string' || typeof metadata.description !== 'string') throw new CommandError('Skill needs name and description');
      row.name = metadata.name; row.description = metadata.description;
      row.omittedMetadata = Object.keys(metadata).filter(k => !['name', 'description'].includes(k));
      const refs: { path: string; content: string }[] = [];
      for (const [p,b] of skillFiles) {
        const relative = p.slice(prefix.length);
        if (relative === 'SKILL.md' || /^(?:LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(relative)) continue;
        if (!SKILL_REFERENCE_RE.test(relative)) throw new CommandError(`Unsupported skill asset ${relative}; the current skill library imports references/*.md and .txt only`);
        refs.push({ path: relative, content: text(b) });
      }
      if (containsSecret(JSON.stringify([original, refs, metadata]), { denylist }).length) throw new CommandError('Skill contains credentials');
      const localLicense = skillFiles.find(([p]) => /^(?:LICENSE|LICENCE)(?:\.(?:md|txt))?$/i.test(p.slice(prefix.length)));
      const skillLicense = localLicense ? detectLicense(text(localLicense[1])) : license;
      const normalized = `---\n${YAML.stringify({ name: row.name, description: row.description })}---\n${match[2]}`;
      const id = `gh-${sha256(src.repo + ':' + filePath).slice(0,16)}`;
      row.draft = previewSkillImport({ files: { id, skillMd: normalized, references: refs, source: `https://github.com/${src.repo}/blob/${commit}/${filePath}`, license: skillLicense } }).draft;
    } catch (e) {
      if (containsSecret((e as Error).message, { denylist }).length || /credential/.test((e as Error).message)) throw new CommandError('Skill contains credentials; import refused');
      row.problems.push((e as Error).message.slice(0, 500));
    }
    skills.push(row);
  }
  return { url: src.url, repo: src.repo, commit, license, licenseSha256: licenseEntry ? sha256(licenseEntry[1]) : null, licensePath: licenseEntry?.[0] ?? null, licenseText: licenseText || null, archiveSha256: sha256(archive), skills, untrusted: true };
}
