// SPDX-License-Identifier: Apache-2.0
// Read immutable Git blobs only. No checkout, project command, hook, install or remote fetch.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { redactJsonStrings,sourcePath } from './redaction.ts';

export interface ProjectFile { path:string;language:string;bytes:number;hash:string;content:string; }
export interface ProjectExtraction {
  revision:string;files:ProjectFile[];totalFiles:number;excludedFiles:number;truncated:boolean;
  languages:Record<string,number>;packages:{path:string;name:string|null;dependencies:string[];scripts:Record<string,string>}[];
}
const MAX_FILES=500,MAX_FILE=64*1024,MAX_TOTAL=5*1024*1024;
const hash=(b:string)=>createHash('sha256').update(b).digest('hex');
const languages:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',rs:'Rust',go:'Go',swift:'Swift',kt:'Kotlin',java:'Java',cs:'C#',cpp:'C++',c:'C',h:'C',rb:'Ruby',php:'PHP',sql:'SQL',sh:'Shell',md:'Markdown',mdx:'Markdown',yaml:'YAML',yml:'YAML',json:'JSON',toml:'TOML',css:'CSS',scss:'CSS',html:'HTML',vue:'Vue',svelte:'Svelte',xml:'XML'};
function eligible(file:string):boolean {
  if(!file||Buffer.byteLength(file)>4096||/[\u0000-\u001f\u007f\\]/.test(file)||file.split('/').some(s=>s==='..'||s==='.'||!s))return false;
  const parts=file.toLowerCase().split('/'),name=parts.at(-1)!;
  if(parts.some(s=>/^(node_modules|vendor|dist|target|build|coverage|graphify-out|\.git|\.aws|\.ssh|\.codex|\.agents|\.cursor|secrets?|credentials?|private)$/.test(s)))return false;
  if(parts.some(s=>s.startsWith('.')&&!['.github','.gitlab'].includes(s)))return false;
  if(/(?:\.lock|lock\.json|\.min\.js|\.map|\.pem|\.key|\.p12|\.pfx|\.crt|\.cer|\.db|\.sqlite|\.snap)$/.test(name)||/^(?:pnpm-lock\.yaml|yarn\.lock|credentials.*|secrets?.*|id_[rd]sa.*|(?:auth|access|refresh)?[_-]?tokens?\.(?:json|ya?ml|txt)|.*password.*|.*\.generated\..*)$/.test(name))return false;
  return Boolean(languages[path.extname(name).slice(1)]||/^(dockerfile(?:\..*)?|makefile|license|notice|gemfile|procfile|go\.mod)$/.test(name));
}
/** A bounded binary-safe Git invocation. Credential helpers and lazy object fetch are disabled. */
async function readGit(repo:string,args:string[],limit:number):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const env={PATH:process.env.PATH,HOME:process.env.HOME,LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
    const child=spawn('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=',...args],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    const chunks:Buffer[]=[];let size=0,failed:Error|null=null;
    const timer=setTimeout(()=>{failed=new Error('Project Git read timed out');child.kill('SIGKILL');},20000);
    child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>limit){failed=new Error('Project Git read exceeded its size limit');child.kill('SIGKILL');}else chunks.push(b);});
    child.stderr.resume(); // errors can include private Git configuration; expose only the exit code
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(failed)reject(failed);else if(code!==0)reject(new Error(`Project Git read failed (${code})`));else resolve(Buffer.concat(chunks));});
  });
}
/** Resolve committed refs with the same no-hook/no-lazy-fetch environment as blob intake. */
export async function projectCommit(repo:string,ref:string):Promise<string|null> {
  if(!path.isAbsolute(repo)||!(ref==='HEAD'||ref.startsWith('refs/heads/')))return null;
  try{const sha=(await readGit(repo,['rev-parse','--verify','--quiet',`${ref}^{commit}`],128)).toString('utf8').trim();return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)?sha:null;}
  catch{return null;}
}
export async function extractProject(repo:string,revision:string,redact:(s:string)=>string):Promise<ProjectExtraction> {
  if(!path.isAbsolute(repo)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))throw new Error('An absolute project path and exact commit SHA are required');
  // cat-file -e verifies it is a commit, not a tree/blob with an equally well-formed object ID.
  await readGit(repo,['cat-file','-e',`${revision}^{commit}`],1000);
  const tree=await readGit(repo,['ls-tree','-r','-l','-z',revision],16*1024*1024);
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const entries=decoder.decode(tree).split('\0').filter(Boolean).map(row=>{
    const tab=row.indexOf('\t'),[mode,type,oid,size]=row.slice(0,tab).trim().split(/\s+/);
    return{mode,type,oid,size:Number(size),path:row.slice(tab+1)};
  });
  const result:ProjectExtraction={revision,files:[],totalFiles:entries.length,excludedFiles:0,truncated:false,languages:{},packages:[]};
  const priority=(p:string)=>/(^|\/)(readme(?:\.md)?|design\.md|agents\.md|package\.json|cargo\.toml|pyproject\.toml|go\.mod|dockerfile|compose\.ya?ml)$/i.test(p)?0:/\.(md|toml|json|ya?ml)$/.test(p)?1:2;
  entries.sort((a,b)=>priority(a.path)-priority(b.path)||a.path.localeCompare(b.path));
  let total=0;const usedPaths=new Set<string>();
  for(const e of entries) {
    if(!['100644','100755'].includes(e.mode)||e.type!=='blob'||!eligible(e.path)){result.excludedFiles++;continue;}
    if(!Number.isSafeInteger(e.size)||e.size>MAX_FILE||result.files.length>=MAX_FILES||total+e.size>MAX_TOTAL){result.excludedFiles++;result.truncated=true;continue;}
    const blob=await readGit(repo,['cat-file','blob',e.oid],MAX_FILE);
    if(blob.includes(0)){result.excludedFiles++;continue;}
    let content:string,raw:string,safePath:string;
    try{raw=decoder.decode(blob);content=redact(redactJsonStrings(raw,redact));safePath=sourcePath(e.path,redact);}
    catch{result.excludedFiles++;continue;}
    // Refuse even a deliberately constructed alias collision rather than overwriting a snapshot.
    if(usedPaths.has(safePath)){result.excludedFiles++;result.truncated=true;continue;}
    const bytes=Buffer.byteLength(content);
    if(bytes>MAX_FILE||total+bytes>MAX_TOTAL){result.excludedFiles++;result.truncated=true;continue;}
    total+=bytes;usedPaths.add(safePath);
    const language=languages[path.extname(e.path).slice(1).toLowerCase()]??'Configuration';
    result.files.push({path:safePath,language,bytes,hash:hash(content),content});result.languages[language]=(result.languages[language]??0)+1;
    if(path.basename(e.path)==='package.json')try{
      const j=JSON.parse(raw);
      const scripts=Object.fromEntries(Object.entries(j.scripts??{}).filter(([k,v])=>k.length<120&&typeof v==='string'&&v.length<2000).map(([k,v])=>[redact(k),redact(v as string)]));
      result.packages.push({path:safePath,name:typeof j.name==='string'?redact(j.name):null,dependencies:[...new Set([...Object.keys(j.dependencies??{}),...Object.keys(j.devDependencies??{})].map(redact))].sort(),scripts});
    }catch{/* A malformed manifest remains cited source text; never execute its scripts. */}
  }
  return result;
}
