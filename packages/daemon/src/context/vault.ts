// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Obsidian vault access for shared context. Notes are plain markdown files, so writes always go
// straight to disk (Obsidian picks them up live, and nothing depends on the app running).
// Search uses the official `obsidian` CLI (1.12.4+) when it is installed AND Obsidian is already
// running (the CLI would otherwise launch the app); otherwise a local markdown search.
//
// Privacy: only the control center's own folder and explicitly listed context folders are ever
// read. Everything else in the vault is invisible to agents.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeConfig, VaultStatus } from '@acc/core';
import { run } from '../exec.ts';
import { whichAll } from '../adapters/agents/detect.ts';
import { sha256 } from '../util/hash.ts';

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

const MAX_FILES = 6000;
const MAX_BYTES = 1024 * 1024;
const PROJECT_MARKER='.one-connect-project',GENERATED_MARKER='.one-connect-generated';
interface Generated {version:2;owner:string|null;notes:Record<string,string>;}

/** Same canonical repository binding that the native registry validates. No display-name input. */
export function projectNamespace(repo:string):string {
  let canonical:string;try{canonical=fs.realpathSync(repo);}catch{canonical=path.resolve(repo);}
  return sha256(canonical);
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'note';
}

export class Vault {
  readonly cfg: KnowledgeConfig;
  readonly root: string;
  readonly folder: string;
  readonly name: string;
  readonly owner:string|null;
  private baseFolder:string;
  private lastWriteAt: string | null = null;
  private lastError: string | null = null;
  /** Injected in tests. */
  isObsidianRunning: () => boolean = () => spawnSync('pgrep', ['-x', 'Obsidian'], { encoding: 'utf8' }).status === 0;

  constructor(cfg: KnowledgeConfig, root: string, owner?:string) {
    this.cfg = cfg;
    this.root = path.resolve(root);
    if(owner&&!/^[a-f0-9]{64}$/.test(owner))throw new Error('Invalid project namespace');
    this.owner=owner??null;
    this.baseFolder=cfg.folder.replace(/^\/+|\/+$/g, '');
    this.folder = this.owner?`${this.baseFolder}/project-${this.owner}`:this.baseFolder;
    this.name = cfg.vault_name ?? path.basename(this.root);
  }

  /** Folders (vault-relative) that may be read: our own plus explicit context folders. */
  readableFolders(): string[] {
    const contexts=this.cfg.context_folders.map(f=>f.replace(/^\/+|\/+$/g,''));
    // A broad selection of the managed parent must not grant access to sibling projects or
    // ambiguous legacy display-name folders. Ordinary explicit shared folders still work.
    return [...new Set([this.folder,...contexts.filter(f=>!this.owner||!(f===this.baseFolder||f.startsWith(this.baseFolder+'/')||this.baseFolder.startsWith(f+'/')))])];
  }

  private projectAllowed(abs:string):boolean {
    if(!this.owner)return true;
    const own=path.resolve(this.root,this.folder),base=path.resolve(this.root,this.baseFolder);
    if((abs===base||abs.startsWith(base+path.sep))&&abs!==own&&!abs.startsWith(own+path.sep))return false;
    if((abs===own||abs.startsWith(own+path.sep))&&fs.existsSync(own)&&!fs.existsSync(path.join(own,PROJECT_MARKER)))return false;
    let ancestor=abs;
    while(ancestor!==this.root) {
      const marker=path.join(ancestor,PROJECT_MARKER);
      if(fs.existsSync(marker)) {
        try{if(fs.lstatSync(marker).isSymbolicLink()||fs.statSync(marker).size>4096||JSON.parse(fs.readFileSync(marker,'utf8')).owner!==this.owner)return false;}
        catch{return false;}
      }
      ancestor=path.dirname(ancestor);
    }
    return true;
  }

  private claim():void {
    if(!this.owner)return;
    const abs=this.resolveInside(this.folder,[this.folder]);
    if(!abs)throw new Error('Project note namespace is outside its owned scope');
    const marker=path.join(abs,PROJECT_MARKER);
    if(fs.existsSync(marker)) {
      if(!this.projectAllowed(abs))throw new Error('Project note namespace belongs to another owner');
      return;
    }
    if(fs.existsSync(abs))throw new Error('Project notes would overwrite an unowned folder');
    fs.mkdirSync(abs,{recursive:true,mode:0o700});
    fs.writeFileSync(marker,JSON.stringify({version:1,owner:this.owner})+'\n',{mode:0o600,flag:'wx'});
  }

  private generated(abs:string):Generated|null {
    try {
      const file=path.join(abs,GENERATED_MARKER),st=fs.lstatSync(file);
      if(!st.isFile()||st.size>1024*1024)return null;
      const data=JSON.parse(fs.readFileSync(file,'utf8')) as Generated;
      if(data.version!==2||data.owner!==this.owner||!data.notes||typeof data.notes!=='object'||Array.isArray(data.notes))return null;
      if(Object.entries(data.notes).some(([name,h])=>!/^(?:[a-f0-9]{64}|Overview)\.md$/.test(name)||typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))return null;
      return data;
    }catch{return null;}
  }

  generatedIntact(rel:string,notes:Record<string,string>):boolean {
    const abs=this.resolveInside(rel,[this.folder]);if(!abs)return false;
    const manifest=this.generated(abs);if(!manifest)return false;
    return JSON.stringify(Object.entries(manifest.notes).sort())===JSON.stringify(Object.entries(notes).sort());
  }

  private resolveInside(rel: string, folders: string[]): string | null {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(this.root, clean);
    const inside = (p: string, base: string) => p === base || p.startsWith(base + path.sep);
    if (!inside(abs, this.root)) return null;
    // Check the nearest existing ancestor too: a not-yet-created note can escape through
    // a symlink in its parent. Refuse symlinks at every level below the selected vault.
    let ancestor = abs;
    while (ancestor !== this.root) {
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) return null; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
      ancestor = path.dirname(ancestor);
    }
    if(!this.projectAllowed(abs))return null;
    for (const f of folders) {
      const base = path.resolve(this.root, f);
      if (!inside(base, this.root)) continue;
      if (abs === base || abs.startsWith(base + path.sep)) {
        // Refuse symlinks that escape either the folder or the vault.
        try {
          const real = fs.realpathSync(abs);
          const realBase = fs.realpathSync(base);
          if (!inside(realBase, fs.realpathSync(this.root))) return null;
          if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
        } catch {
          /* Missing paths were checked via their ancestors above. */
        }
        return abs;
      }
    }
    return null;
  }

  /** Vault-relative path of a note in our folder, e.g. "Agent Control Center/app/Brief.md". */
  notePath(...parts: string[]): string {
    return [this.folder, ...parts].join('/');
  }

  /** Wikilink target (vault-relative, no extension). */
  link(rel: string, label?: string): string {
    const target = rel.replace(/\.md$/, '');
    return label ? `[[${target}|${label}]]` : `[[${target}]]`;
  }

  openUrl(rel = this.notePath('Brief.md')): string {
    return `obsidian://open?vault=${encodeURIComponent(this.name)}&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`;
  }

  /** Write a note in our folder if its content changed. Returns true if written. */
  write(rel: string, content: string): boolean {
    this.claim();
    const abs = this.resolveInside(rel, [this.folder]);
    if (!abs) throw new Error(`refusing to write outside ${this.folder}: ${rel}`);
    const hash = createHash('sha1').update(content).digest('hex');
    try {
      if (fs.existsSync(abs) && createHash('sha1').update(fs.readFileSync(abs)).digest('hex') === hash) {
        return false;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.acc-tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, abs);
      this.lastWriteAt = new Date().toISOString();
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  /** Atomically replace only a marked, app-generated collection; user-authored notes stay outside it. */
  replaceGenerated(rel:string,notes:Record<string,string>):void {
    this.claim();
    const abs=this.resolveInside(rel,[this.folder]);
    if(!abs||abs===path.resolve(this.root,this.folder))throw new Error('Invalid generated note directory');
    const marker=GENERATED_MARKER;
    const owned=(p:string)=>!fs.existsSync(p)||(!fs.lstatSync(p).isSymbolicLink()&&fs.statSync(p).isDirectory()&&Boolean(this.generated(p)));
    const stage=path.join(path.dirname(abs),`.${path.basename(abs)}.one-connect-next`),backup=path.join(path.dirname(abs),`.${path.basename(abs)}.one-connect-previous`);
    if(!this.resolveInside(path.relative(this.root,stage),[this.folder])||!this.resolveInside(path.relative(this.root,backup),[this.folder])||![abs,stage,backup].every(owned))throw new Error('Generated notes would overwrite an unowned folder');
    if(!fs.existsSync(abs)&&fs.existsSync(backup))fs.renameSync(backup,abs);
    const disposable=(p:string)=>!fs.existsSync(p)||fs.readdirSync(p).every(name=>name===marker||Object.hasOwn(this.generated(p)!.notes,name));
    if(![stage,backup].every(disposable))throw new Error('Interrupted generated notes contain unowned additions; preserved for recovery');
    for(const name of Object.keys(notes))if(!/^(?:[a-f0-9]{64}|Overview)\.md$/.test(name))throw new Error('Invalid generated note name');
    const prior=this.generated(abs),extra=fs.existsSync(abs)?fs.readdirSync(abs).filter(name=>name!==marker&&!Object.hasOwn(prior!.notes,name)):[];
    if(extra.some(name=>Object.hasOwn(notes,name)))throw new Error('Generated notes would overwrite an unowned note');
    fs.mkdirSync(path.dirname(abs),{recursive:true});fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{mode:0o700});
    const manifest:Generated={version:2,owner:this.owner,notes:Object.fromEntries(Object.entries(notes).map(([name,content])=>[name,sha256(content)]))};
    fs.writeFileSync(path.join(stage,marker),JSON.stringify(manifest)+'\n',{mode:0o600});
    for(const [name,content]of Object.entries(notes))fs.writeFileSync(path.join(stage,name),content,{mode:0o600});
    fs.rmSync(backup,{recursive:true,force:true});
    if(fs.existsSync(abs))fs.renameSync(abs,backup);
    // Move unregistered user additions without reading their bodies or deleting them. They
    // remain outside the generated registry and cannot acquire committed-source attribution.
    const moved:string[]=[];
    try{for(const name of extra){fs.renameSync(path.join(backup,name),path.join(stage,name));moved.push(name);}fs.renameSync(stage,abs);}
    catch(e){for(const name of moved)fs.renameSync(path.join(stage,name),path.join(backup,name));if(fs.existsSync(backup))fs.renameSync(backup,abs);throw e;}
    fs.rmSync(backup,{recursive:true,force:true});
    this.lastWriteAt=new Date().toISOString();
  }

  /**
   * Incremental update of a marked, app-generated collection: write changed notes and delete
   * removed ones, each with an atomic rename, then commit the registry last. Unregistered user
   * notes are never overwritten, read or deleted. Readers validate note hashes against the
   * registry, so a note seen mid-update cannot claim attribution it does not have.
   */
  patchGenerated(rel:string,write:Record<string,string>,remove:string[]):void {
    this.claim();
    const abs=this.resolveInside(rel,[this.folder]);
    if(!abs||abs===path.resolve(this.root,this.folder))throw new Error('Invalid generated note directory');
    if(!fs.existsSync(abs)||fs.lstatSync(abs).isSymbolicLink()||!fs.statSync(abs).isDirectory())throw new Error('Generated notes are missing; a full rebuild is required');
    const prior=this.generated(abs);if(!prior)throw new Error('Generated notes would overwrite an unowned folder');
    for(const name of [...Object.keys(write),...remove])if(!/^(?:[a-f0-9]{64}|Overview)\.md$/.test(name))throw new Error('Invalid generated note name');
    const present=new Set(fs.readdirSync(abs));
    if(Object.keys(write).some(name=>present.has(name)&&!Object.hasOwn(prior.notes,name)))throw new Error('Generated notes would overwrite an unowned note');
    const notes={...prior.notes};
    for(const [name,content] of Object.entries(write)) {
      const tmp=path.join(abs,`.${name}.one-connect-tmp`);
      fs.writeFileSync(tmp,content,{mode:0o600});fs.renameSync(tmp,path.join(abs,name));notes[name]=sha256(content);
    }
    for(const name of remove) {
      if(!Object.hasOwn(prior.notes,name))continue;
      const file=path.join(abs,name);
      try{if(!fs.lstatSync(file).isSymbolicLink())fs.rmSync(file,{force:true});else fs.unlinkSync(file);}catch{/* already gone */}
      delete notes[name];
    }
    const manifest:Generated={version:2,owner:this.owner,notes};
    const tmp=path.join(abs,`${GENERATED_MARKER}.tmp`);
    fs.writeFileSync(tmp,JSON.stringify(manifest)+'\n',{mode:0o600});fs.renameSync(tmp,path.join(abs,GENERATED_MARKER));
    this.lastWriteAt=new Date().toISOString();
  }

  /** Registered note names and hashes of a generated collection (null when not owned/intact). */
  generatedNotes(rel:string):Record<string,string>|null {
    const abs=this.resolveInside(rel,[this.folder]);if(!abs)return null;
    return this.generated(abs)?.notes??null;
  }

  read(rel: string): string {
    const withExt = rel.endsWith('.md') ? rel : `${rel}.md`;
    const abs = this.resolveInside(withExt, this.readableFolders());
    if (!abs) throw new Error(`"${rel}" is outside the folders agents may read (${this.readableFolders().join(', ')})`);
    if (!fs.existsSync(abs)) throw new Error(`no such note: ${withExt}`);
    const collection=path.resolve(this.root,this.notePath('Dictionary'));
    if(this.owner&&abs.startsWith(collection+path.sep)) {
      const manifest=this.generated(collection);
      if(!manifest||!Object.hasOwn(manifest.notes,path.relative(collection,abs)))throw new Error('Note is outside the generated source registry');
    }
    const st = fs.statSync(abs);
    if (st.size > MAX_BYTES) throw new Error(`note is too large (${st.size} bytes)`);
    return fs.readFileSync(abs, 'utf8');
  }

  private walk(): string[] {
    const files: string[] = [];
    const visit = (dir: string) => {
      if (files.length >= MAX_FILES) return;
      if(!this.resolveInside(path.relative(this.root,dir),this.readableFolders()))return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (files.length >= MAX_FILES) break;
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visit(p);
        else if (e.isFile() && e.name.endsWith('.md')) files.push(p);
      }
    };
    for (const f of this.readableFolders()) {
      const abs = this.resolveInside(f, [f]);
      if (abs) visit(abs);
    }
    return [...new Set(files)];
  }

  /** Read only selected markdown files; shared by local and semantic indexes. */
  *documents(): Generator<{ path: string; content: string }> {
    for (const abs of this.walk()) {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      try { yield { path: rel, content: this.read(rel) }; } catch { /* vanished, oversized or no longer in scope */ }
    }
  }

  /** Local markdown search over the readable folders (term frequency + title boost). */
  searchFs(query: string, limit = 8): SearchHit[] {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const doc of this.documents()) {
      const text = doc.content;
      const lower = text.toLowerCase();
      const title = path.basename(doc.path, '.md').toLowerCase();
      let score = 0;
      for (const t of terms) {
        score += lower.split(t).length - 1;
        if (title.includes(t)) score += 5;
      }
      if (score === 0) continue;
      const line = text.split('\n').find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? '';
      hits.push({ path: doc.path, score, snippet: line.trim().slice(0, 240) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---- official Obsidian CLI ---------------------------------------------------------------

  cliPath(): string | null {
    if (this.cfg.obsidian_cli === 'off') return null;
    const cands = [this.cfg.obsidian_binary, ...whichAll(['obsidian']), '/usr/local/bin/obsidian'].filter(Boolean) as string[];
    return cands.find((p) => fs.existsSync(p)) ?? null;
  }

  /** Use the CLI only if installed and (in auto mode) Obsidian is already running. */
  cliUsable(): { usable: boolean; path: string | null; note: string } {
    const p = this.cliPath();
    if (this.cfg.obsidian_cli === 'off') return { usable: false, path: null, note: 'disabled in config' };
    if(this.owner)return {usable:false,path:p,note:'project scopes use local search to exclude other owners before reading notes'};
    if (!p) return { usable: false, path: null, note: 'not installed: enable Settings → General → Command line interface (Obsidian 1.12.4+)' };
    if (this.cfg.obsidian_cli === 'auto' && !this.isObsidianRunning()) return { usable: false, path: p, note: 'installed; Obsidian is not running, so local search is used (the CLI would launch the app)' };
    return { usable: true, path: p, note: 'using the official Obsidian CLI' };
  }

  async search(query: string, limit = 8): Promise<{ backend: 'fs' | 'obsidian-cli'; hits: SearchHit[] }> {
    const cli = this.cliUsable();
    if (cli.usable && cli.path) {
      try {
        const hits: SearchHit[] = [];
        for (const folder of this.readableFolders().filter((f) => fs.existsSync(path.resolve(this.root, f)))) {
          const r = await run(cli.path, [`vault=${this.name}`, 'search', `query=${query}`, `path=${folder}`, `limit=${limit}`, 'format=json'], { timeoutMs: 15_000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
          for (const p of parseCliPaths(r.stdout)) {
            const abs = this.resolveInside(p, this.readableFolders());
            if (!abs || !fs.existsSync(abs)) continue;
            const text = this.read(p);
            const line = text.split('\n').find((l) => l.toLowerCase().includes(query.toLowerCase().split(/\s+/)[0] ?? '')) ?? '';
            hits.push({ path: p, score: limit - hits.length, snippet: line.trim().slice(0, 240) });
          }
        }
        return { backend: 'obsidian-cli', hits: hits.slice(0, limit) };
      } catch (e) {
        this.lastError = `obsidian CLI search failed, used local search: ${(e as Error).message}`;
      }
    }
    return { backend: 'fs', hits: this.searchFs(query, limit) };
  }

  status(): VaultStatus {
    const cli = this.cliUsable();
    let notes = 0;
    try {
      const own = this.resolveInside(this.folder, [this.folder]);
      const count = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : e.name.endsWith('.md') ? 1 : 0), 0);
      notes = own && fs.existsSync(own) ? count(own) : 0;
    } catch {
      /* unreadable */
    }
    return {
      root: this.root,
      folder: this.folder,
      backend: cli.usable ? 'obsidian-cli' : 'fs',
      cli: { available: Boolean(cli.path), path: cli.path, note: cli.note },
      notes,
      lastWriteAt: this.lastWriteAt,
      openUrl: this.openUrl(),
      error: fs.existsSync(this.root) ? this.lastError : `vault folder ${this.root} does not exist`,
    };
  }
}

/** The CLI's JSON search output: an array of paths or of objects with a path/file field. */
export function parseCliPaths(out: string): string[] {
  try {
    const j = JSON.parse(out) as unknown;
    const arr = Array.isArray(j) ? j : Array.isArray((j as { results?: unknown }).results) ? (j as { results: unknown[] }).results : [];
    return arr
      .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x ? String((x as Record<string, unknown>).path ?? (x as Record<string, unknown>).file ?? '') : ''))
      .filter(Boolean);
  } catch {
    return out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.md'));
  }
}
