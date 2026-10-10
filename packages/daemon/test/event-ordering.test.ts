// SPDX-License-Identifier: Apache-2.0
// Observe the actual authenticated WebSocket and two bus listeners, including a nested commit.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SYSTEM, type EventEnvelope } from '@acc/core';
import { createServer } from '../src/server/http.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
let h:Harness|null=null;let server:Awaited<ReturnType<typeof createServer>>|null=null;let socket:WebSocket|null=null;
afterEach(async()=>{socket?.close();await server?.app.close();await h?.close();socket=null;server=null;h=null;});
it('delivers every outer batch before nested commits to all bus listeners and the live dashboard',async()=>{
  h=await startDaemon(makeConfig(makeRepo()),{probe:false,server:false});const d=h.d;
  const observerA:number[]=[];const observerB:number[]=[];
  let nested=false;
  d.bus.on('events',(events:EventEnvelope[])=>{observerA.push(...events.map(e=>e.seq));if(!nested&&events.some(e=>e.type==='daemon.started'&&e.data.pid===123)){nested=true;d.commit([{type:'daemon.started',actor:SYSTEM,data:{version:'nested-fixture',pid:456}}]);}});
  // The server listener is registered after the nesting listener, reproducing the original bug.
  server=await createServer(d,{port:0});
  d.bus.on('events',(events:EventEnvelope[])=>observerB.push(...events.map(e=>e.seq)));
  const token=fs.readFileSync(path.join(d.paths.secrets,'install-token'),'utf8').trim();
  const response=await fetch(server.url+'/api/auth/ws-ticket',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});expect(response.status).toBe(200);
  const {ticket}=await response.json() as {ticket:string};
  const received:Array<{type:string;events?:EventEnvelope[]}>=[];
  socket=new WebSocket(server.url.replace(/^http/,'ws')+`/ws?ticket=${encodeURIComponent(ticket)}`);
  socket.addEventListener('message',e=>received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve,reject)=>{socket!.addEventListener('open',()=>resolve(),{once:true});socket!.addEventListener('error',()=>reject(new Error('fixture socket failed')),{once:true});});
  socket.send(JSON.stringify({type:'hello',since:0}));await waitFor(()=>received.some(m=>m.type==='snapshot'),5000);
  const before=d.state.seq;
  d.commit([{type:'daemon.started',actor:SYSTEM,data:{version:'outer-fixture',pid:123}},{type:'daemon.started',actor:SYSTEM,data:{version:'outer-fixture',pid:124}}]);
  await waitFor(()=>received.flatMap(m=>m.events??[]).some(e=>e.seq===before+3),5000);
  const relevant=(seqs:number[])=>seqs.filter(n=>n>before&&n<=before+3);
  expect(relevant(observerA)).toEqual([before+1,before+2,before+3]);expect(relevant(observerB)).toEqual(relevant(observerA));
  expect(relevant(received.flatMap(m=>m.events??[]).map(e=>e.seq))).toEqual(relevant(observerA));
  expect(d.store.list({afterSeq:before,limit:3}).map(e=>e.seq)).toEqual(relevant(observerA));
});
