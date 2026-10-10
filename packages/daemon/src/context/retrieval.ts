// SPDX-License-Identifier: Apache-2.0
// Hybrid retrieval policy for Dictionary, independent of storage:
//   1. keyword (SQLite FTS5 bm25) and, when configured, local semantic rankings are fused (RRF);
//   2. path / symbol mentions in the question boost the matching source;
//   3. the top seeds are expanded along the declarative import/mention graph;
//   4. near-duplicates and overlapping passages are removed, at most N passages per source;
//   5. passages are packed into a hard character budget.
// Evidence sufficiency is computed from the selected excerpts only — never from model output.
import { createHash } from 'node:crypto';
import type { DocEvidence } from '@acc/core';

export const STOP_WORDS=new Set('a an and are as at be been but by can could do does did for from had has have how i if in into is it its may more my need of on or our should that the their them then there these they this those to was we were what when where which who whom why will with would you your again about any each per much many most long often does done use used using'.split(' '));
/** Query terms for keyword search (stop words removed, bounded). */
export const queryTerms=(s:string)=>[...new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)??[])].filter(t=>!STOP_WORDS.has(t)).slice(0,24);
/** Light, language-agnostic stem used only for evidence coverage. */
const stem=(w:string)=>w.length>5?w.slice(0,5):w;
const words=(s:string)=>s.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[];

export interface Candidate { id:string; path:string; title:string; content:string; line:number; endLine:number; }
export interface Ranked extends Candidate { score:number; via:'keyword'|'semantic'|'graph'; }
export interface Expansion { path:string; reason:string; }

/** Reciprocal-rank fusion of several rankings. */
export function fuse(lists:{rows:Candidate[];via:'keyword'|'semantic';weight?:number}[]):Map<string,Ranked> {
  const out=new Map<string,Ranked>();
  for(const {rows,via,weight=1} of lists)rows.forEach((row,i)=>{
    const prev=out.get(row.id);const add=weight/(60+i+1);
    out.set(row.id,prev?{...prev,score:prev.score+add}:{...row,score:add,via});
  });
  return out;
}

/** Paths, file names and identifiers the question mentions explicitly. */
export function mentions(query:string):{paths:string[];names:string[];identifiers:string[]} {
  const paths=[...query.matchAll(/(?:^|[\s`'"(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,10})/g)].map(m=>m[1]);
  const names=[...query.matchAll(/(?:^|[\s`'"(])([\w@-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?=[\s`'"),?.]|$)/g)].map(m=>m[1].toLowerCase()).filter(n=>!/^\d/.test(n));
  const identifiers=[...query.matchAll(/`([\p{L}_$][\p{L}\p{N}_$]{2,80})`|\b([a-z]+[A-Z][\p{L}\p{N}]*|[A-Z][a-z]+[A-Z][\p{L}\p{N}]*|[a-z]+_[a-z_]+|[A-Z][A-Z0-9_]{3,})\b/gu)].map(m=>m[1]??m[2]);
  return {paths:[...new Set(paths)],names:[...new Set(names)],identifiers:[...new Set(identifiers)].slice(0,12)};
}

/** Coverage of the question's meaningful terms by the selected excerpts. */
export function evidence(query:string,excerpts:string[],threshold=0.6):DocEvidence {
  const terms=[...new Set(words(query).filter(w=>!STOP_WORDS.has(w)&&w.length>2).map(stem))];
  if(!terms.length||!excerpts.length)return {support:'insufficient',coverage:0,terms,missing:terms};
  const have=new Set(excerpts.flatMap(e=>words(e).map(stem)));
  const missing=terms.filter(t=>!have.has(t)),coverage=Math.round(((terms.length-missing.length)/terms.length)*100)/100;
  return {support:coverage>=threshold?'supported':'insufficient',coverage,terms,missing};
}

const norm=(s:string)=>s.replace(/\s+/g,' ').trim().toLowerCase();
const digest=(s:string)=>createHash('sha256').update(norm(s)).digest('hex');

export interface SelectOptions { limit:number; budget:number; perSource:number; }
/**
 * Choose passages in score order: skip near-duplicates (same normalized text) and passages that
 * overlap an already chosen passage of the same source; cap passages per source.
 */
export function select(ranked:Ranked[],o:SelectOptions,sourceOf:(r:Ranked)=>string=r=>r.path):{chosen:Ranked[];deduplicated:number} {
  const chosen:Ranked[]=[],seen=new Set<string>(),perSource=new Map<string,number>();let deduplicated=0,chars=0;
  for(const r of ranked) {
    if(chosen.length>=o.limit||chars>=o.budget)break;
    const h=digest(r.content),src=sourceOf(r);
    if(seen.has(h)||chosen.some(c=>c.path===r.path&&c.line<=r.endLine&&r.line<=c.endLine)){deduplicated++;continue;}
    if((perSource.get(src)??0)>=o.perSource){deduplicated++;continue;}
    seen.add(h);perSource.set(src,(perSource.get(src)??0)+1);chosen.push(r);chars+=r.content.length;
  }
  return {chosen,deduplicated};
}

/** Order candidates: fused score plus explicit mention boosts. */
export function order(fused:Map<string,Ranked>,boost:(r:Ranked)=>number):Ranked[] {
  return [...fused.values()].map(r=>({...r,score:r.score+boost(r)})).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)||a.line-b.line);
}

/** Best passage of an expanded neighbor for this question: most query-term overlap, else first. */
export function bestPassage(rows:Candidate[],query:string):Candidate|null {
  if(!rows.length)return null;
  const q=new Set(queryTerms(query));
  let best=rows[0],score=-1;
  for(const r of rows){const s=words(r.content).filter(w=>q.has(w)).length;if(s>score){best=r;score=s;}}
  return best;
}
