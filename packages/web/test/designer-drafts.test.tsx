// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerDraft } from '../src/components/designer/shared';
import { clearPhoneAuthority, setRemoteSession } from '../src/lib/remote';
const native = vi.hoisted(() => ({ project: 'alpha', flushes: new Set<() => Promise<void>>() }));
vi.mock('../src/lib/desktop', () => ({
  isDesktop: true, activeProject: () => ({project:native.project}), ProjectSwitched: class extends Error {},
  desktopRequest: vi.fn(),
  onBeforeProjectSwitch: (f:()=>Promise<void>) => {native.flushes.add(f);return ()=>native.flushes.delete(f);},
}));
import { desktopRequest } from '../src/lib/desktop';
const request = vi.mocked(desktopRequest);
let stored:unknown=null;
beforeEach(()=>{vi.useFakeTimers();native.project='alpha';native.flushes.clear();stored=null;setRemoteSession(null,'local');request.mockReset();request.mockImplementation(async (_p,init)=>{if(init.method==='PUT'){stored=init.body;return {draft:{savedAt:'2026-10-09T00:00:00Z'}};}if(init.method==='DELETE'){stored=null;return {ok:true};}return {draft:null};});});
afterEach(()=>{cleanup();vi.clearAllTimers();vi.useRealTimers();clearPhoneAuthority();});
const open = async()=>{const h=renderHook(()=>useServerDraft('brief',()=>''));await act(async()=>{});expect(h.result.current.loaded).toBe(true);return h;};

describe('Designer draft receipts and project isolation',()=>{
  it('flushes the latest edit before native routing changes, even inside the debounce window',async()=>{
    const h=await open();act(()=>h.result.current.setValue('alpha draft'));
    await act(async()=>{for(const f of native.flushes)await f();});
    expect(stored).toEqual({value:'alpha draft'});
    expect(request.mock.calls.find(([,i])=>i.method==='PUT')?.[1].project).toBe('alpha');
    native.project='beta';h.unmount();await act(async()=>{});
    expect(request.mock.calls.filter(([,i])=>i.method==='PUT')).toHaveLength(1);
  });
  it('never routes an unmount flush to another project or a replaced identity',async()=>{
    const h=await open();act(()=>h.result.current.setValue('private alpha'));
    native.project='beta';h.unmount();await act(async()=>{});
    expect(request.mock.calls.filter(([,i])=>i.method==='PUT')).toHaveLength(0);
  });
  it('does not let an older save receipt mark a newer edit as saved, and serializes discard',async()=>{
    const h=await open();let finish!:(value:unknown)=>void;
    request.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    act(()=>h.result.current.setValue('first'));
    let first!:Promise<void>;await act(async()=>{first=h.result.current.flush();});
    act(()=>h.result.current.setValue('second'));
    await act(async()=>{finish({draft:{savedAt:'2026-10-09T00:00:00Z'}});await first;});
    expect(h.result.current.dirty).toBe(true);
    await act(async()=>{await h.result.current.discard();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(900);});
    expect(h.result.current.value).toBe('');expect(h.result.current.dirty).toBe(false);expect(stored).toBeNull();
    expect(request.mock.calls.filter(([,i])=>i.method==='PUT')).toHaveLength(1);
  });
  it('retains edits and reports a failed discard, and rejects a failed flush before switching',async()=>{
    const h=await open();act(()=>h.result.current.setValue('keep me'));
    request.mockRejectedValueOnce(new Error('unreachable'));
    await act(async()=>{await h.result.current.discard();});
    expect(h.result.current.value).toBe('keep me');expect(h.result.current.error).toContain('not cleared');
    request.mockRejectedValueOnce(new Error('unreachable'));
    await act(async()=>{await expect([...native.flushes][0]()).rejects.toThrow();});
    expect(h.result.current.dirty).toBe(true);
  });
  it('does not overwrite a draft it failed to read',async()=>{
    request.mockRejectedValueOnce(new Error('unreachable'));
    const h=renderHook(()=>useServerDraft('brief',()=>''));await act(async()=>{});
    expect(h.result.current.loaded).toBe(false);expect(h.result.current.error).toContain('Could not load');
    act(()=>h.result.current.setValue('overwrite'));
    await act(async()=>{await vi.advanceTimersByTimeAsync(900);});
    expect(request.mock.calls.filter(([,i])=>i.method==='PUT')).toHaveLength(0);
  });
});
