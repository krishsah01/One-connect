// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable Dictionary ingestion manifest. Private daemon data (0600), separate from the vault.
//
//   blobs      content-addressed REDACTED source text, keyed by (Git object ID, redaction policy).
//              Immutable rows, so an interrupted intake resumes without re-reading finished blobs.
//   snapshot   one row per included file of a published generation (path key → blob).
//   generations published, immutable source identities with their stage results and changes.
//   structure  symbols / edges / manifests of the current generation.
//
// Raw repository paths are never stored: rows use sha256(raw path) as the key and the redacted,
// alias-safe source path for display. Blobs no longer referenced by a kept generation are removed,
// so deleted files and content redacted under an older policy stop being retrievable.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DictionaryChanges, DictionaryJob, DictionaryStage, DictionaryStageName } from '@acc/core';
import type { ProjectStructure, StructureEdge, StructureManifest, StructureSymbol } from './structure.ts';

export const PIPELINE_VERSION='dictionary-v4.1';
export const pathKey=(raw:string)=>createHash('sha256').update('path\n'+raw).digest('hex');

export interface BlobRow { oid:string; policy:string; bytes:number; hash:string; content:string; lines:number; }
export interface SnapshotRow { key:string; path:string; oid:string; language:string; bytes:number; hash:string; lines:number; noteHash:string; }
export interface Generation {
  id:string; revision:string; policy:string; scope:string; createdAt:string; files:number; totalFiles:number; excludedFiles:number; truncated:boolean;
  languages:Record<string,number>; stages:Record<DictionaryStageName,DictionaryStage>; changes:DictionaryChanges|null;
}

export class AnswerManifest {
  readonly db:DatabaseSync;
  constructor(file:string) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);
    fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS blobs(oid TEXT NOT NULL,policy TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,content TEXT NOT NULL,lines INTEGER NOT NULL,PRIMARY KEY(oid,policy));
      CREATE TABLE IF NOT EXISTS snapshot(generation TEXT NOT NULL,key TEXT NOT NULL,path TEXT NOT NULL,oid TEXT NOT NULL,language TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,lines INTEGER NOT NULL,note_hash TEXT NOT NULL,PRIMARY KEY(generation,key));
      CREATE INDEX IF NOT EXISTS snapshot_path ON snapshot(generation,path);
      CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,revision TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols(generation TEXT NOT NULL,path TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,line INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(generation,name);
      CREATE INDEX IF NOT EXISTS symbols_path ON symbols(generation,path);
      CREATE TABLE IF NOT EXISTS edges(generation TEXT NOT NULL,src TEXT NOT NULL,dst TEXT NOT NULL,kind TEXT NOT NULL,line INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS edges_src ON edges(generation,src);
      CREATE INDEX IF NOT EXISTS edges_dst ON edges(generation,dst);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  close(){this.db.close();}
  private tx<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  meta(key:string):string|null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value??null; }
  setMeta(key:string,value:string|null){ if(value===null)this.db.prepare('DELETE FROM meta WHERE key=?').run(key);else this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value); }

  // ---- blobs ------------------------------------------------------------------------------
  blob(oid:string,policy:string):BlobRow|null { return (this.db.prepare('SELECT * FROM blobs WHERE oid=? AND policy=?').get(oid,policy) as BlobRow|undefined)??null; }
  hasBlob(oid:string,policy:string):boolean { return Boolean(this.db.prepare('SELECT 1 FROM blobs WHERE oid=? AND policy=?').get(oid,policy)); }
  putBlobs(rows:BlobRow[]){ const st=this.db.prepare('INSERT OR IGNORE INTO blobs(oid,policy,bytes,hash,content,lines) VALUES(?,?,?,?,?,?)'); this.tx(()=>{for(const r of rows)st.run(r.oid,r.policy,r.bytes,r.hash,r.content,r.lines);}); }

  // ---- generations --------------------------------------------------------------------------
  current():Generation|null { const id=this.meta('current');return id?this.generation(id):null; }
  generation(id:string):Generation|null {
    const row=this.db.prepare('SELECT data FROM generations WHERE id=?').get(id) as {data:string}|undefined;
    try{return row?JSON.parse(row.data) as Generation:null;}catch{return null;}
  }
  snapshot(generation:string):SnapshotRow[] { return this.db.prepare('SELECT key,path,oid,language,bytes,hash,lines,note_hash AS noteHash FROM snapshot WHERE generation=? ORDER BY path').all(generation) as unknown as SnapshotRow[]; }
  snapshotFile(generation:string,safePath:string):SnapshotRow|null { return (this.db.prepare('SELECT key,path,oid,language,bytes,hash,lines,note_hash AS noteHash FROM snapshot WHERE generation=? AND path=?').get(generation,safePath) as SnapshotRow|undefined)??null; }
  /** Committed redacted content of one file of a generation, or null. */
  content(generation:string,safePath:string,policy:string):string|null {
    const r=this.db.prepare('SELECT b.content FROM snapshot s JOIN blobs b ON b.oid=s.oid AND b.policy=? WHERE s.generation=? AND s.path=?').get(policy,generation,safePath) as {content:string}|undefined;
    return r?.content??null;
  }

  /**
   * Publish a generation, its snapshot and its structure in ONE transaction and make it current.
   * Readers either see the previous complete generation or this one, never a mixture.
   */
  publish(g:Generation,rows:SnapshotRow[],structure:ProjectStructure|null){
    this.tx(()=>{
      this.db.prepare('INSERT OR REPLACE INTO generations(id,revision,data,created_at) VALUES(?,?,?,?)').run(g.id,g.revision,JSON.stringify(g),g.createdAt);
      this.db.prepare('DELETE FROM snapshot WHERE generation=?').run(g.id);
      const s=this.db.prepare('INSERT INTO snapshot(generation,key,path,oid,language,bytes,hash,lines,note_hash) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const r of rows)s.run(g.id,r.key,r.path,r.oid,r.language,r.bytes,r.hash,r.lines,r.noteHash);
      if(structure)this.writeStructure(g.id,structure);
      this.setMeta('current',g.id);
    });
    this.retainCurrent();
  }
  /** Stage results change after publication (vectors, graph); the source identity does not. */
  updateStages(id:string,stages:Partial<Record<DictionaryStageName,DictionaryStage>>){
    const g=this.generation(id);if(!g)return;
    const next={...g,stages:{...g.stages,...stages}};
    this.db.prepare('UPDATE generations SET data=? WHERE id=?').run(JSON.stringify(next),id);
  }
  /**
   * Keep only the current generation. Changes are computed before publication, so no previous
   * snapshot is needed: content of deleted files and blobs redacted under an older policy are
   * removed here. Blobs of the current policy left by a cancelled intake are removed too.
   */
  retainCurrent(){
    const current=this.meta('current');if(!current)return;
    this.tx(()=>{
      this.db.prepare('DELETE FROM generations WHERE id<>?').run(current);
      for(const t of ['snapshot','symbols','edges'])this.db.prepare(`DELETE FROM ${t} WHERE generation<>?`).run(current);
      for(const row of this.db.prepare("SELECT key FROM meta WHERE key LIKE 'structure:%'").all() as {key:string}[])if(row.key!==`structure:${current}`)this.setMeta(row.key,null);
      this.db.prepare('DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.oid=blobs.oid AND s.generation=?) OR policy<>?').run(current,this.generation(current)?.policy??'');
    });
  }

  // ---- structure -----------------------------------------------------------------------------
  private writeStructure(generation:string,s:ProjectStructure){
    this.db.prepare('DELETE FROM symbols WHERE generation=?').run(generation);this.db.prepare('DELETE FROM edges WHERE generation=?').run(generation);
    const sym=this.db.prepare('INSERT INTO symbols(generation,path,name,kind,line) VALUES(?,?,?,?,?)'),edge=this.db.prepare('INSERT INTO edges(generation,src,dst,kind,line) VALUES(?,?,?,?,?)');
    for(const x of s.symbols)sym.run(generation,x.path,x.name,x.kind,x.line);
    for(const e of s.edges)edge.run(generation,e.from,e.to,e.kind,e.line);
    this.setMeta(`structure:${generation}`,JSON.stringify({manifests:s.manifests,entryPoints:s.entryPoints,truncated:s.truncated,external:s.external.slice(0,2000)}));
  }
  structureSummary(generation:string):{files:number;symbols:number;edges:number;entryPoints:string[];manifests:StructureManifest[];truncated:boolean;external:{path:string;name:string;line:number}[]}|null {
    const raw=this.meta(`structure:${generation}`);if(!raw)return null;
    const extra=JSON.parse(raw) as {manifests:StructureManifest[];entryPoints:string[];truncated:boolean;external:{path:string;name:string;line:number}[]};
    const n=(sql:string)=>Number((this.db.prepare(sql).get(generation) as {n:number}).n);
    return {files:n('SELECT count(*) AS n FROM snapshot WHERE generation=?'),symbols:n('SELECT count(*) AS n FROM symbols WHERE generation=?'),edges:n('SELECT count(*) AS n FROM edges WHERE generation=?'),...extra};
  }
  edgesOf(generation:string,file:string,limit=24):StructureEdge[] {
    return (this.db.prepare('SELECT src AS "from",dst AS "to",kind,line FROM edges WHERE generation=? AND (src=? OR dst=?) LIMIT ?').all(generation,file,file,limit) as unknown as StructureEdge[]);
  }
  symbolsOf(generation:string,file:string,limit=80):StructureSymbol[] {
    return this.db.prepare('SELECT path,name,kind,line FROM symbols WHERE generation=? AND path=? ORDER BY line LIMIT ?').all(generation,file,limit) as unknown as StructureSymbol[];
  }
  findSymbols(generation:string,names:string[],limit=20):StructureSymbol[] {
    if(!names.length)return [];
    return this.db.prepare(`SELECT path,name,kind,line FROM symbols WHERE generation=? AND kind<>'heading' AND lower(name) IN (${names.map(()=>'?').join(',')}) LIMIT ?`).all(generation,...names.map(n=>n.toLowerCase()),limit) as unknown as StructureSymbol[];
  }
  /** Highest-degree files: a cheap, honest "central modules" view. */
  central(generation:string,limit=12):{path:string;inbound:number;outbound:number}[] {
    return this.db.prepare(`SELECT p AS path,sum(i) AS inbound,sum(o) AS outbound FROM (SELECT dst AS p,1 AS i,0 AS o FROM edges WHERE generation=? AND kind<>'mention' UNION ALL SELECT src AS p,0 AS i,1 AS o FROM edges WHERE generation=? AND kind<>'mention') GROUP BY p HAVING sum(i)>0 ORDER BY inbound DESC,outbound DESC,p LIMIT ?`).all(generation,generation,limit) as unknown as {path:string;inbound:number;outbound:number}[];
  }

  // ---- jobs ------------------------------------------------------------------------------------
  job():DictionaryJob|null { try{const raw=this.meta('job');return raw?JSON.parse(raw) as DictionaryJob:null;}catch{return null;} }
  saveJob(job:DictionaryJob|null){ this.setMeta('job',job?JSON.stringify(job):null); }
}
