// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Declarative project structure for Dictionary: symbols, file-to-file imports, doc→code mentions,
// manifests and entry points, parsed from the already redacted committed snapshot with regular
// expressions only. Nothing is executed, installed, resolved over the network or evaluated.
// This is an import/mention graph, not a call graph and not Graphify.
import path from 'node:path';

export interface StructureFile { path:string; language:string; content:string; }
export interface StructureSymbol { path:string; name:string; kind:string; line:number; }
export type EdgeKind='import'|'mention'|'module';
export interface StructureEdge { from:string; to:string; kind:EdgeKind; line:number; }
export interface StructureManifest { path:string; ecosystem:string; name:string|null; dependencies:string[]; scripts:Record<string,string>; }
export interface ProjectStructure {
  symbols:StructureSymbol[]; edges:StructureEdge[]; external:{path:string;name:string;line:number}[];
  manifests:StructureManifest[]; entryPoints:string[]; truncated:boolean;
}

const MAX_SYMBOLS_PER_FILE=200,MAX_EDGES=40_000,MAX_SYMBOLS=60_000;
const JS_EXT=['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'];
const ident=(s:string)=>/^[\p{L}_$][\p{L}\p{N}_$]{0,119}$/u.test(s);

/** Pre-computed line starts, so many regex matches per file stay linear. */
function lineIndex(text:string):(i:number)=>number {
  const starts=[0];for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)starts.push(i+1);
  return i=>{let lo=0,hi=starts.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(starts[mid]<=i)lo=mid;else hi=mid-1;}return lo+1;};
}

const SYMBOL_PATTERNS:Record<string,{re:RegExp;kind:string}[]>={
  TypeScript:[{re:/^[ \t]*export[ \t]+(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(function\*?|class|const|let|var|interface|type|enum|namespace)[ \t]+([\p{L}_$][\p{L}\p{N}_$]*)/gmu,kind:''},{re:/^(?:async[ \t]+)?(function|class)[ \t]+([\p{L}_$][\p{L}\p{N}_$]*)/gmu,kind:''}],
  Python:[{re:/^(?:async[ \t]+)?(def|class)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''}],
  Rust:[{re:/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?(fn|struct|enum|trait|mod|type|const|static|macro_rules!)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''}],
  Go:[{re:/^(func)[ \t]+(?:\([^)]*\)[ \t]*)?([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''},{re:/^(type)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''}],
  Swift:[{re:/^[ \t]*(?:(?:public|private|internal|fileprivate|open|final|static|@\w+)[ \t]+)*(func|class|struct|enum|protocol|actor|extension)[ \t]+([\p{L}_][\p{L}\p{N}_.]*)/gmu,kind:''}],
  Kotlin:[{re:/^[ \t]*(?:(?:public|private|internal|open|data|sealed|abstract)[ \t]+)*(fun|class|object|interface)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''}],
  Java:[{re:/^[ \t]*(?:(?:public|private|protected|static|final|abstract)[ \t]+)*(class|interface|enum|record)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu,kind:''}],
  Markdown:[{re:/^(#{1,3})[ \t]+(.{1,120})$/gmu,kind:'heading'}],
};
SYMBOL_PATTERNS.JavaScript=SYMBOL_PATTERNS.TypeScript;

function symbolsOf(f:StructureFile,line:(i:number)=>number):StructureSymbol[] {
  const out:StructureSymbol[]=[],seen=new Set<string>();
  for(const {re,kind} of SYMBOL_PATTERNS[f.language]??[]) {
    re.lastIndex=0;
    for(const m of f.content.matchAll(re)) {
      if(out.length>=MAX_SYMBOLS_PER_FILE)break;
      const name=m[2].trim(),k=kind||m[1].replace(/\*$/,'').replace('!','');
      if(kind!=='heading'&&!ident(name.split('.')[0]))continue;
      const key=`${k}:${name}`;if(seen.has(key))continue;seen.add(key);
      out.push({path:f.path,name,kind:k,line:line(m.index??0)});
    }
  }
  return out;
}

interface Resolver { files:Set<string>; dirs:Map<string,string[]>; workspaces:Map<string,string>; goModules:{name:string;dir:string}[]; swiftTargets:Map<string,string>; }

function resolveJs(from:string,spec:string,r:Resolver):string|null {
  let base:string;
  if(spec.startsWith('./')||spec.startsWith('../'))base=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
  else {
    // Workspace package (e.g. @acc/core or @acc/core/sub) declared by a package.json in this repo.
    const parts=spec.split('/'),name=spec.startsWith('@')?parts.slice(0,2).join('/'):parts[0],rest=spec.slice(name.length).replace(/^\//,'');
    const dir=r.workspaces.get(name);if(dir===undefined)return null;
    base=rest?path.posix.join(dir,rest):dir;
    if(!rest)for(const entry of ['src/index','index','src/main','lib/index'])for(const ext of JS_EXT){const c=path.posix.join(dir,entry+ext);if(r.files.has(c))return c;}
  }
  if(base.startsWith('..'))return null;
  if(r.files.has(base))return base;
  const stem=base.replace(/\.(?:m?js|cjs|jsx)$/,'');
  for(const ext of JS_EXT){if(r.files.has(stem+ext))return stem+ext;}
  for(const ext of JS_EXT){const c=path.posix.join(base,'index'+ext);if(r.files.has(c))return c;}
  return null;
}

function resolvePython(from:string,spec:string,r:Resolver):string|null {
  let mod=spec,dir='';
  const dots=/^\.+/.exec(spec)?.[0].length??0;
  if(dots){dir=path.posix.dirname(from);for(let i=1;i<dots;i++)dir=path.posix.dirname(dir);mod=spec.slice(dots);}
  const rel=mod.replace(/\./g,'/');
  const roots=dots?[dir]:['','src','lib','app'];
  for(const root of roots) {
    const b=path.posix.join(root||'.',rel).replace(/^\.\//,'');
    for(const c of [b+'.py',path.posix.join(b,'__init__.py')])if(r.files.has(c))return c;
  }
  return null;
}

function resolveRustMod(from:string,name:string,r:Resolver):string|null {
  const file=path.posix.basename(from),dir=path.posix.dirname(from);
  const base=['main.rs','lib.rs','mod.rs'].includes(file)?dir:path.posix.join(dir,file.replace(/\.rs$/,''));
  for(const c of [path.posix.join(base,name+'.rs'),path.posix.join(base,name,'mod.rs')])if(r.files.has(c.replace(/^\.\//,'')))return c.replace(/^\.\//,'');
  return null;
}

function resolveRustUse(from:string,spec:string,r:Resolver):string|null {
  const parts=spec.split('::');if(parts[0]!=='crate')return null;
  const srcIdx=from.split('/').lastIndexOf('src'),root=srcIdx>=0?from.split('/').slice(0,srcIdx+1).join('/'):'src';
  for(let n=parts.length-1;n>=2;n--) {
    const rel=parts.slice(1,n).join('/');
    for(const c of [path.posix.join(root,rel+'.rs'),path.posix.join(root,rel,'mod.rs')])if(r.files.has(c))return c;
  }
  return null;
}

function edgesOf(f:StructureFile,r:Resolver,line:(i:number)=>number,external:ProjectStructure['external']):StructureEdge[] {
  const out:StructureEdge[]=[],add=(to:string|null,kind:EdgeKind,at:number)=>{if(to&&to!==f.path&&!out.some(e=>e.to===to&&e.kind===kind))out.push({from:f.path,to,kind,line:line(at)});};
  const ext=(name:string,at:number)=>{if(name&&external.length<20_000&&!external.some(e=>e.path===f.path&&e.name===name))external.push({path:f.path,name,line:line(at)});};
  const c=f.content;
  if(f.language==='TypeScript'||f.language==='JavaScript'||f.language==='Vue'||f.language==='Svelte') {
    const re=/(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"\n]{1,300})['"]|(?:^|[\s;(=])import\s*['"]([^'"\n]{1,300})['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g;
    for(const m of c.matchAll(re)){const spec=m[1]??m[2]??m[3];const to=resolveJs(f.path,spec,r);if(to)add(to,'import',m.index??0);else if(!spec.startsWith('.'))ext(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0],m.index??0);}
  } else if(f.language==='Python') {
    for(const m of c.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w, \t*()]+)/gm)) {
      const mod=m[1];
      // `from . import a, b` imports sibling modules first; only otherwise the package itself.
      let named=false;
      if(/^\.+$/.test(mod))for(const n of m[2].replace(/[()]/g,'').split(',').map(s=>s.trim().split(/\s+/)[0]).filter(Boolean)){const t=resolvePython(f.path,mod+n,r);if(t){add(t,'import',m.index??0);named=true;}}
      const to=named?null:resolvePython(f.path,mod,r);
      if(to)add(to,'import',m.index??0);else if(!named&&!mod.startsWith('.'))ext(mod.split('.')[0],m.index??0);
    }
    for(const m of c.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm))for(const mod of m[1].split(',').map(s=>s.trim())){const to=resolvePython(f.path,mod,r);if(to)add(to,'import',m.index??0);else ext(mod.split('.')[0],m.index??0);}
  } else if(f.language==='Rust') {
    for(const m of c.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm))add(resolveRustMod(f.path,m[1],r),'module',m.index??0);
    for(const m of c.matchAll(/^[ \t]*(?:pub[ \t]+)?use[ \t]+([A-Za-z_][\w:]*)/gm)){const to=resolveRustUse(f.path,m[1],r);if(to)add(to,'import',m.index??0);else if(!/^(?:crate|self|super|std|core|alloc)\b/.test(m[1]))ext(m[1].split('::')[0],m.index??0);}
  } else if(f.language==='Go') {
    const block=/import\s*\(([^)]*)\)|import\s+(?:[\w.]+\s+)?"([^"]+)"/g;
    for(const m of c.matchAll(block)) {
      const specs=m[2]?[m[2]]:[...(m[1]??'').matchAll(/"([^"]+)"/g)].map(x=>x[1]);
      for(const spec of specs) {
        // Longest matching module path wins; its go.mod directory anchors the package directory.
        const mod=r.goModules.filter(g=>spec===g.name||spec.startsWith(g.name+'/')).sort((a,b)=>b.name.length-a.name.length)[0];
        if(mod){const dir=path.posix.join(mod.dir||'.',spec.slice(mod.name.length).replace(/^\//,'')).replace(/^\.\/?/,'');for(const to of (r.dirs.get(dir)??[]).filter(p=>p.endsWith('.go')&&!p.endsWith('_test.go')).slice(0,3))add(to,'import',m.index??0);}
        else if(spec.includes('.'))ext(spec,m.index??0);
      }
    }
  } else if(f.language==='Swift') {
    for(const m of c.matchAll(/^[ \t]*(?:@testable[ \t]+)?import[ \t]+(\w+)/gm)){const dir=r.swiftTargets.get(m[1]);if(dir!==undefined)for(const to of (r.dirs.get(dir)??[]).filter(p=>p.endsWith('.swift')).slice(0,3))add(to,'import',m.index??0);else ext(m[1],m.index??0);}
  } else if(f.language==='Markdown') {
    for(const m of c.matchAll(/\]\(([^)\s#?]{1,300})(?:#[^)]*)?\)/g)) {
      const target=m[1];if(/^[a-z][a-z0-9+.-]*:/i.test(target))continue;
      const rel=path.posix.normalize(path.posix.join(path.posix.dirname(f.path),decodeURI(target))).replace(/^\.\//,'');
      if(r.files.has(rel))add(rel,'mention',m.index??0);
    }
    for(const m of c.matchAll(/`([\w@./-]{3,300}\.[A-Za-z0-9]{1,10})`|(?:^|[\s(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,10})(?=[\s),.;:]|$)/gm)) {
      const p=(m[1]??m[2]).replace(/^\.\//,'');if(r.files.has(p))add(p,'mention',m.index??0);
    }
  }
  return out;
}

/** Strip TOML/INI-ish comments and return `[section]` → body lines. Declarative only. */
function tomlSections(text:string):Map<string,string[]> {
  const out=new Map<string,string[]>();let cur='';out.set(cur,[]);
  for(const raw of text.split('\n')){const l=raw.replace(/(^|\s)#.*$/,'').trim();if(!l)continue;const h=/^\[+\s*([^\]]+?)\s*\]+$/.exec(l);if(h){cur=h[1];if(!out.has(cur))out.set(cur,[]);continue;}out.get(cur)!.push(l);}
  return out;
}

function manifestOf(f:StructureFile):StructureManifest|null {
  const name=path.posix.basename(f.path).toLowerCase(),c=f.content;
  const uniq=(xs:string[])=>[...new Set(xs.filter(x=>x&&x.length<200))].sort().slice(0,500);
  try {
    if(name==='package.json') {
      const j=JSON.parse(c) as Record<string,unknown>;const deps=(k:string)=>Object.keys((j[k]??{}) as object);
      const scripts=Object.fromEntries(Object.entries((j.scripts??{}) as Record<string,unknown>).filter(([k,v])=>k.length<120&&typeof v==='string'&&v.length<2000)) as Record<string,string>;
      return {path:f.path,ecosystem:'npm',name:typeof j.name==='string'?j.name:null,dependencies:uniq([...deps('dependencies'),...deps('devDependencies'),...deps('peerDependencies')]),scripts};
    }
    if(name==='cargo.toml') {
      const s=tomlSections(c),pkg=(s.get('package')??[]).map(l=>/^name\s*=\s*"([^"]+)"/.exec(l)?.[1]).find(Boolean)??null;
      const deps=[...s.entries()].filter(([k])=>/(^|\.)(?:dev-|build-)?dependencies$/.test(k)).flatMap(([,ls])=>ls.map(l=>/^([A-Za-z0-9_-]+)\s*=/.exec(l)?.[1]??''));
      return {path:f.path,ecosystem:'cargo',name:pkg,dependencies:uniq(deps),scripts:{}};
    }
    if(name==='pyproject.toml') {
      const s=tomlSections(c),projectName=[...(s.get('project')??[]),...(s.get('tool.poetry')??[])].map(l=>/^name\s*=\s*"([^"]+)"/.exec(l)?.[1]).find(Boolean)??null;
      const arr=/dependencies\s*=\s*\[([\s\S]*?)\]/.exec(c)?.[1]??'';
      const deps=[...arr.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map(m=>m[1]).concat((s.get('tool.poetry.dependencies')??[]).map(l=>/^([A-Za-z0-9_.-]+)\s*=/.exec(l)?.[1]??'').filter(d=>d!=='python'));
      const scripts=Object.fromEntries((s.get('project.scripts')??s.get('tool.poetry.scripts')??[]).map(l=>/^([\w.-]+)\s*=\s*"([^"]{1,500})"/.exec(l)).filter(Boolean).map(m=>[m![1],m![2]]));
      return {path:f.path,ecosystem:'python',name:projectName,dependencies:uniq(deps),scripts};
    }
    if(/^requirements[\w.-]*\.txt$/.test(name))return {path:f.path,ecosystem:'python',name:null,dependencies:uniq(c.split('\n').map(l=>/^\s*([A-Za-z0-9_.-]+)/.exec(l.replace(/#.*/,''))?.[1]??'')),scripts:{}};
    if(name==='go.mod') {
      const mod=/^module\s+(\S+)/m.exec(c)?.[1]??null,req=[...c.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[\w.+-]+/gm)].map(m=>m[1]);
      return {path:f.path,ecosystem:'go',name:mod,dependencies:uniq(req),scripts:{}};
    }
    if(name==='package.swift') {
      const pkg=/Package\s*\(\s*name:\s*"([^"]+)"/.exec(c)?.[1]??null,deps=[...c.matchAll(/\.package\s*\([^)]*?(?:url|path):\s*"([^"]+)"/g)].map(m=>m[1].replace(/\.git$/,'').split('/').pop()!);
      return {path:f.path,ecosystem:'swiftpm',name:pkg,dependencies:uniq(deps),scripts:{}};
    }
    if(name==='gemfile')return {path:f.path,ecosystem:'ruby',name:null,dependencies:uniq([...c.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map(m=>m[1])),scripts:{}};
    if(name==='dockerfile'||name.startsWith('dockerfile.')) {
      const from=[...c.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map(m=>m[1]),expose=[...c.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].map(m=>m[1].trim());
      return {path:f.path,ecosystem:'docker',name:null,dependencies:uniq(from),scripts:expose.length?{expose:expose.join(' ')}:{}};
    }
    if(/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(name)) {
      const services=/^services:\s*\n((?:[ \t]+.*\n?)*)/m.exec(c)?.[1]??'',names=[...services.matchAll(/^[ \t]{2}([A-Za-z0-9_.-]+):/gm)].map(m=>m[1]),images=[...c.matchAll(/^\s+image:\s*["']?([^\s"']+)/gm)].map(m=>m[1]);
      return {path:f.path,ecosystem:'compose',name:null,dependencies:uniq(images),scripts:names.length?{services:names.join(', ')}:{}};
    }
  } catch { /* malformed manifests stay cited source text; never evaluated */ }
  return null;
}

const ENTRY=/(^|\/)(?:readme(?:\.md)?|agents\.md|claude\.md|design\.md|architecture\.md|package\.json|cargo\.toml|pyproject\.toml|go\.mod|package\.swift|dockerfile|(?:docker-)?compose\.ya?ml|main\.(?:ts|tsx|js|mjs|py|rs|go|swift)|index\.(?:ts|tsx|js|mjs)|lib\.rs|app\.(?:py|ts|tsx|js)|__main__\.py|manage\.py|server\.(?:ts|js|py|go))$/i;

export function analyzeStructure(files:StructureFile[]):ProjectStructure {
  const result:ProjectStructure={symbols:[],edges:[],external:[],manifests:[],entryPoints:[],truncated:false};
  const r:Resolver={files:new Set(files.map(f=>f.path)),dirs:new Map(),workspaces:new Map(),goModules:[],swiftTargets:new Map()};
  for(const f of files){const dir=path.posix.dirname(f.path)==='.'?'':path.posix.dirname(f.path);r.dirs.set(dir,[...(r.dirs.get(dir)??[]),f.path]);}
  for(const f of files) {
    const m=manifestOf(f);if(!m)continue;result.manifests.push(m);
    const dir=path.posix.dirname(f.path)==='.'?'':path.posix.dirname(f.path);
    if(m.ecosystem==='npm'&&m.name)r.workspaces.set(m.name,dir);
    if(m.ecosystem==='go'&&m.name)r.goModules.push({name:m.name,dir});
  }
  for(const dir of r.dirs.keys()){const m=/(?:^|\/)Sources\/([^/]+)$/.exec(dir);if(m)r.swiftTargets.set(m[1],dir);}
  for(const f of files) {
    const line=lineIndex(f.content);
    if(result.symbols.length<MAX_SYMBOLS)result.symbols.push(...symbolsOf(f,line).slice(0,MAX_SYMBOLS-result.symbols.length));else result.truncated=true;
    if(result.edges.length<MAX_EDGES)result.edges.push(...edgesOf(f,r,line,result.external).slice(0,MAX_EDGES-result.edges.length));else result.truncated=true;
  }
  const indegree=new Map<string,number>();for(const e of result.edges)if(e.kind!=='mention')indegree.set(e.to,(indegree.get(e.to)??0)+1);
  const declared=files.filter(f=>ENTRY.test(f.path)&&f.path.split('/').length<=4).map(f=>f.path).sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
  const central=[...indegree.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,8).map(([p])=>p);
  result.entryPoints=[...new Set([...declared.slice(0,12),...central])].slice(0,20);
  return result;
}

/** Neighbors of a file in the import/mention graph, both directions, bounded. */
export function neighbors(edges:readonly StructureEdge[],file:string,limit=12):{path:string;direction:'out'|'in';kind:EdgeKind}[] {
  const out:{path:string;direction:'out'|'in';kind:EdgeKind}[]=[];
  for(const e of edges){if(out.length>=limit)break;if(e.from===file)out.push({path:e.to,direction:'out',kind:e.kind});else if(e.to===file)out.push({path:e.from,direction:'in',kind:e.kind});}
  return out;
}

