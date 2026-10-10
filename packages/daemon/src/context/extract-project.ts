// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read immutable Git blobs only. No checkout, project command, hook, install or remote fetch.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { redactJsonStrings,sourcePath } from './redaction.ts';
import { analyzeStructure } from './structure.ts';

export interface ProjectFile { path:string;language:string;bytes:number;hash:string;content:string; }
export interface ProjectPackage { path:string;name:string|null;dependencies:string[];scripts:Record<string,string>;ecosystem?:string; }
export interface ProjectExtraction {
  revision:string;files:ProjectFile[];totalFiles:number;excludedFiles:number;truncated:boolean;
  languages:Record<string,number>;packages:ProjectPackage[];
}
export interface ExtractLimits { files:number;fileBytes:number;totalBytes:number; }
/** Defaults sized for a real mid-sized repository; anything beyond is reported as partial. */
export const DEFAULT_LIMITS:ExtractLimits={files:2000,fileBytes:64*1024,totalBytes:16*1024*1024};
const hash=(b:string)=>createHash('sha256').update(b).digest('hex');
export const LANGUAGES:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',mts:'TypeScript',cts:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',pyi:'Python',rs:'Rust',go:'Go',swift:'Swift',kt:'Kotlin',kts:'Kotlin',java:'Java',cs:'C#',cpp:'C++',cc:'C++',hpp:'C++',c:'C',h:'C',m:'Objective-C',rb:'Ruby',php:'PHP',sql:'SQL',sh:'Shell',bash:'Shell',zsh:'Shell',md:'Markdown',mdx:'Markdown',yaml:'YAML',yml:'YAML',json:'JSON',toml:'TOML',ini:'INI',cfg:'INI',css:'CSS',scss:'CSS',html:'HTML',vue:'Vue',svelte:'Svelte',xml:'XML',graphql:'GraphQL',proto:'Protobuf',tf:'Terraform',prisma:'Prisma'};
export function languageOf(file:string):string { return LANGUAGES[path.extname(file).slice(1).toLowerCase()]??'Configuration'; }

/** Declarative eligibility: path shape and name only, before any blob is read. */
export function eligible(file:string):boolean {
  if(!file||Buffer.byteLength(file)>4096||/[\u0000-\u001f\u007f\\]/.test(file)||file.split('/').some(s=>s==='..'||s==='.'||!s))return false;
  const parts=file.toLowerCase().split('/'),name=parts.at(-1)!;
  if(parts.some(s=>/^(node_modules|vendor|dist|target|build|coverage|graphify-out|__pycache__|\.build|deriveddata|pods|venv|\.venv|\.git|\.aws|\.ssh|\.codex|\.agents|\.cursor|secrets?|credentials?|private)$/.test(s)))return false;
  if(parts.some(s=>s.startsWith('.')&&!['.github','.gitlab'].includes(s)))return false;
  if(/(?:\.lock|lock\.json|\.min\.js|\.min\.css|\.map|\.pem|\.key|\.p12|\.pfx|\.crt|\.cer|\.db|\.sqlite|\.snap|\.tfstate)$/.test(name)||/^(?:pnpm-lock\.yaml|yarn\.lock|package\.resolved|credentials.*|secrets?.*|id_[rd]sa.*|id_ed25519.*|(?:auth|access|refresh)?[_-]?tokens?\.(?:json|ya?ml|txt)|.*password.*|.*\.generated\..*|.*_pb2\.py|.*\.pb\.go)$/.test(name))return false;
  return Boolean(LANGUAGES[path.extname(name).slice(1)]||/^(dockerfile(?:\..*)?|containerfile|makefile|license|notice|gemfile|procfile|go\.mod|requirements[\w.-]*\.txt|cmakelists\.txt)$/.test(name));
}

const gitEnv=()=>({PATH:process.env.PATH,HOME:process.env.HOME,LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
const gitArgs=(args:string[])=>['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=',...args];

/** A bounded binary-safe Git invocation. Credential helpers and lazy object fetch are disabled. */
async function readGit(repo:string,args:string[],limit:number,input?:string,signal?:AbortSignal):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('Project intake was cancelled'));return;}
    const child=spawn('git',gitArgs(args),{cwd:repo,env:gitEnv(),stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let size=0,failed:Error|null=null;
    const timer=setTimeout(()=>{failed=new Error('Project Git read timed out');child.kill('SIGKILL');},60000);
    const onAbort=()=>{failed=new Error('Project intake was cancelled');child.kill('SIGKILL');};
    signal?.addEventListener('abort',onAbort,{once:true});
    child.stdout!.on('data',(b:Buffer)=>{size+=b.length;if(size>limit){failed=new Error('Project Git read exceeded its size limit');child.kill('SIGKILL');}else chunks.push(b);});
    child.stderr!.resume(); // errors can include private Git configuration; expose only the exit code
    child.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(e);});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(failed)reject(failed);else if(code!==0)reject(new Error(`Project Git read failed (${code})`));else resolve(Buffer.concat(chunks));});
    if(input!==undefined){child.stdin!.on('error',()=>undefined);child.stdin!.end(input);}
  });
}
/** Resolve committed refs with the same no-hook/no-lazy-fetch environment as blob intake. */
export async function projectCommit(repo:string,ref:string):Promise<string|null> {
  if(!path.isAbsolute(repo)||!(ref==='HEAD'||ref.startsWith('refs/heads/')))return null;
  try{const sha=(await readGit(repo,['rev-parse','--verify','--quiet',`${ref}^{commit}`],128)).toString('utf8').trim();return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)?sha:null;}
  catch{return null;}
}
const COMMIT=/^([a-f0-9]{40}|[a-f0-9]{64})$/;

/** Paths changed between two exact commits (rename-aware), bounded. Raw paths: callers redact. */
export async function changedPaths(repo:string,from:string,to:string,limit=2000,signal?:AbortSignal):Promise<{status:string;path:string;from?:string}[]|null> {
  if(!COMMIT.test(from)||!COMMIT.test(to))return null;
  try {
    const raw=(await readGit(repo,['diff-tree','-r','-z','-M','--name-status','--no-commit-id',from,to],8*1024*1024,undefined,signal)).toString('utf8').split('\0');
    const out:{status:string;path:string;from?:string}[]=[];
    for(let i=0;i<raw.length&&out.length<limit;) {
      const status=raw[i++];if(!status)continue;
      if(status.startsWith('R')||status.startsWith('C')){const a=raw[i++],b=raw[i++];out.push({status:status[0],path:b,from:a});}
      else out.push({status:status[0],path:raw[i++]});
    }
    return out;
  } catch { return null; }
}

export interface TreeEntry { mode:string;type:string;oid:string;size:number;path:string; }
/** Every tree entry at an exact commit (paths raw; never persisted without redaction). */
export async function listTree(repo:string,revision:string,signal?:AbortSignal):Promise<TreeEntry[]> {
  if(!path.isAbsolute(repo)||!COMMIT.test(revision))throw new Error('An absolute project path and exact commit SHA are required');
  // cat-file -e verifies it is a commit, not a tree/blob with an equally well-formed object ID.
  await readGit(repo,['cat-file','-e',`${revision}^{commit}`],1000,undefined,signal);
  const tree=await readGit(repo,['ls-tree','-r','-l','-z',revision],64*1024*1024,undefined,signal);
  const decoder=new TextDecoder('utf-8',{fatal:true});
  return decoder.decode(tree).split('\0').filter(Boolean).map(row=>{
    const tab=row.indexOf('\t'),[mode,type,oid,size]=row.slice(0,tab).trim().split(/\s+/);
    return{mode,type,oid,size:Number(size),path:row.slice(tab+1)};
  });
}
/** Docs, manifests and entry points first, so a size-limited snapshot keeps the most useful files. */
export const intakePriority=(p:string)=>/(^|\/)(readme(?:\.md)?|design\.md|agents\.md|claude\.md|architecture\.md|package\.json|cargo\.toml|pyproject\.toml|go\.mod|package\.swift|dockerfile|(?:docker-)?compose\.ya?ml)$/i.test(p)?0:/\.(md|mdx|toml|json|ya?ml)$/i.test(p)?1:/(^|\/)(test|tests|__tests__|spec|fixtures?|examples?)\//i.test(p)?3:2;

/**
 * Read many blobs through one `git cat-file --batch` process. Returns raw bytes per object ID;
 * missing or non-blob objects are omitted. Bounded by the sum of the requested sizes.
 */
export async function readBlobs(repo:string,entries:{oid:string;size:number}[],signal?:AbortSignal):Promise<Map<string,Buffer>> {
  const out=new Map<string,Buffer>();
  const oids=[...new Set(entries.map(e=>e.oid))].filter(o=>/^[a-f0-9]{40,64}$/.test(o));
  if(!oids.length)return out;
  const limit=entries.reduce((n,e)=>n+e.size,0)+oids.length*160+1024;
  const raw=await readGit(repo,['cat-file','--batch'],limit,oids.join('\n')+'\n',signal);
  let i=0;
  while(i<raw.length) {
    const nl=raw.indexOf(10,i);if(nl<0)break;
    const header=raw.subarray(i,nl).toString('latin1'),[oid,type,sizeText]=header.split(' ');
    if(type==='missing'||sizeText===undefined){i=nl+1;continue;}
    const size=Number(sizeText);if(!Number.isSafeInteger(size)||size<0)throw new Error('Unexpected Git batch output');
    if(type==='blob')out.set(oid,Buffer.from(raw.subarray(nl+1,nl+1+size)));
    i=nl+1+size+1;
  }
  return out;
}

export type DecodedBlob={ok:true;content:string;raw:string;bytes:number;hash:string}|{ok:false;reason:'binary'|'encoding'|'size'};
/** Decode and redact one blob. Redaction happens before anything is stored or indexed. */
export function decodeBlob(blob:Buffer,redact:(s:string)=>string,maxBytes:number):DecodedBlob {
  if(blob.includes(0))return {ok:false,reason:'binary'};
  let raw:string;
  try{raw=new TextDecoder('utf-8',{fatal:true}).decode(blob);}catch{return {ok:false,reason:'encoding'};}
  const content=redact(redactJsonStrings(raw,redact)),bytes=Buffer.byteLength(content);
  if(bytes>maxBytes)return {ok:false,reason:'size'};
  return {ok:true,content,raw,bytes,hash:hash(content)};
}

const MANIFEST=/(^|\/)(package\.json|cargo\.toml|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|package\.swift|gemfile|dockerfile(?:\..*)?|(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml)$/i;
/** Packages from every supported manifest, redacted. Never executes a manifest or its scripts. */
export function manifestsOf(files:{path:string;language:string;content:string}[],redact:(s:string)=>string):ProjectPackage[] {
  return analyzeStructure(files.filter(f=>MANIFEST.test(f.path)))
    .manifests.map(m=>({path:m.path,ecosystem:m.ecosystem,name:m.name?redact(m.name):null,dependencies:[...new Set(m.dependencies.map(redact))].sort(),scripts:Object.fromEntries(Object.entries(m.scripts).map(([k,v])=>[redact(k),redact(v)]))}));
}

export async function extractProject(repo:string,revision:string,redact:(s:string)=>string,limits:Partial<ExtractLimits>={}):Promise<ProjectExtraction> {
  const L={...DEFAULT_LIMITS,...limits};
  if(!path.isAbsolute(repo)||!COMMIT.test(revision))throw new Error('An absolute project path and exact commit SHA are required');
  const entries=await listTree(repo,revision);
  const result:ProjectExtraction={revision,files:[],totalFiles:entries.length,excludedFiles:0,truncated:false,languages:{},packages:[]};
  entries.sort((a,b)=>intakePriority(a.path)-intakePriority(b.path)||a.path.localeCompare(b.path));
  const wanted:TreeEntry[]=[];let planned=0;
  for(const e of entries) {
    if(!['100644','100755'].includes(e.mode)||e.type!=='blob'||!eligible(e.path)){result.excludedFiles++;continue;}
    if(!Number.isSafeInteger(e.size)||e.size>L.fileBytes||wanted.length>=L.files||planned+e.size>L.totalBytes){result.excludedFiles++;result.truncated=true;continue;}
    wanted.push(e);planned+=e.size;
  }
  const blobs=await readBlobs(repo,wanted);
  let total=0;const usedPaths=new Set<string>();
  for(const e of wanted) {
    const blob=blobs.get(e.oid);if(!blob){result.excludedFiles++;continue;}
    const decoded=decodeBlob(blob,redact,L.fileBytes);
    if(!decoded.ok){result.excludedFiles++;if(decoded.reason==='size')result.truncated=true;continue;}
    let safePath:string;try{safePath=sourcePath(e.path,redact);}catch{result.excludedFiles++;continue;}
    // Refuse even a deliberately constructed alias collision rather than overwriting a snapshot.
    if(usedPaths.has(safePath)){result.excludedFiles++;result.truncated=true;continue;}
    if(total+decoded.bytes>L.totalBytes){result.excludedFiles++;result.truncated=true;continue;}
    total+=decoded.bytes;usedPaths.add(safePath);
    const language=languageOf(e.path);
    result.files.push({path:safePath,language,bytes:decoded.bytes,hash:decoded.hash,content:decoded.content});result.languages[language]=(result.languages[language]??0)+1;
  }
  result.packages=manifestsOf(result.files,redact);
  return result;
}
