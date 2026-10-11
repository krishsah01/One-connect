// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useEffect, useState } from 'react';
import type { DesignDocument } from '@acc/core';
import { api } from '../../../lib/api';
import { DocumentRenderer } from './DocumentRenderer';
export function StructuredStage({artifactId,rev,width}:{artifactId:string;rev:number;width:number}){
  const [doc,setDoc]=useState<DesignDocument|null>(null),[screen,setScreen]=useState(''),[error,setError]=useState(''),[dark,setDark]=useState(false),[assets,setAssets]=useState<Record<string,string>>({});
  useEffect(()=>{let alive=true;setDoc(null);void api<{document:DesignDocument;source:Record<string,string>}>(`/api/designer/releases/${artifactId}/${rev}`).then(r=>{if(alive){setDoc(r.document);setScreen(r.document.screens[0].id);setAssets(Object.fromEntries(Object.values(r.document.assets).map(a=>[a.id,`data:${a.mime};base64,${r.source[`assets/${a.hash}`]}`])));}},e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[artifactId,rev]);
  if(error)return <div role="alert">{error}</div>;
  if(!doc)return <div role="status">Loading frozen design release…</div>;
  return <section aria-label={`Structured release revision ${rev}`}><div className="row"><select aria-label="Design screen" value={screen} onChange={e=>setScreen(e.target.value)}>{doc.screens.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button onClick={()=>setDark(v=>!v)}>{dark?'Dark':'Light'}</button><span>Interactive structured design · revision {rev}</span></div><div style={{overflow:'auto',maxHeight:850}}><div style={{width}}><DocumentRenderer document={doc} screenId={screen} width={width} dark={dark} assetUrl={id=>assets[id]}/></div></div></section>;
}
