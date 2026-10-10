// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Preview of one exact revision, page and viewport. In the browser dashboard the mock is shown as a
// script-free layout render in an iframe sandboxed with no permissions. Interactive execution only
// happens in the desktop app's isolated native preview window.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ErrorLine, useAction } from '../common';
import { api } from '../../lib/api';
import { identityRevision, onPhoneAuthorityCleared } from '../../lib/remote';
import { activeProject, isDesktop } from '../../lib/desktop';

export interface Preview { html: string; shell: string | null; shellError: string | null; static: string; execution: string; pages: string[]; hash: string; rev: number; page: string }
export interface Viewport { name: string; width: number; height: number }

// Revisions are immutable, so a preview never changes for the same id, revision and page.
const cache = new Map<string, Promise<Preview>>();
onPhoneAuthorityCleared(() => cache.clear());
export function loadPreview(id: string, rev: number, page: string): Promise<Preview> {
  const key = `${activeProject()?.project ?? "browser"}:${identityRevision()}:${id}:${rev}:${page}`;
  let p = cache.get(key);
  if (!p) {
    p = api<Preview>(`/api/mocks/${id}/revisions/${rev}/preview?page=${encodeURIComponent(page)}`);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Fits a fixed-size viewport into the available width without changing the layout width. */
function useFit(width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setScale(Math.min(1, Math.max(0.1, (el.clientWidth - 2) / width)));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return { ref, scale };
}

export function StaticFrame({ doc, viewport, title }: { doc: string; viewport: Viewport; title: string }) {
  const { ref, scale } = useFit(viewport.width);
  return <div ref={ref} style={{ width: '100%' }}>
    <div className="stage-frame-wrap" style={{ width: viewport.width * scale + 2, height: viewport.height * scale + 2 }}>
      {/* sandbox="" grants nothing: no scripts, forms, popups, navigation or same-origin access. */}
      <iframe title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={doc} style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }} />
    </div>
  </div>;
}

export function MockStage({ id, rev, page, viewport, title, onPages }: { id: string; rev: number; page: string; viewport: Viewport; title: string; onPages?: (pages: string[]) => void }) {
  const { busy, error, run } = useAction();
  const [preview, setPreview] = useState<Preview | null>(null), [loadError, setLoadError] = useState('');
  const [opened, setOpened] = useState('');
  useEffect(() => {
    let alive = true; setPreview(null); setLoadError('');
    loadPreview(id, rev, page).then(p => { if (alive) { setPreview(p); onPages?.(p.pages); } }, e => alive && setLoadError((e as Error).message));
    return () => { alive = false; };
  }, [id, rev, page]);
  const openNative = () => run(async () => {
    if (!preview?.shell) throw new Error(preview?.shellError ?? 'Preview unavailable');
    await invoke('open_mock_preview', { shell: preview.shell, width: viewport.width, height: viewport.height });
    setOpened(`Opened revision ${rev} · ${page} at ${viewport.name} ${viewport.width}×${viewport.height} in an isolated window.`);
  });
  return <section className="stage" aria-label={`Preview of ${page}, revision ${rev}, ${viewport.name} ${viewport.width} by ${viewport.height}`}>
    {loadError ? <ErrorLine error={`Preview unavailable: ${loadError}`} /> : !preview ? <div className="empty" role="status">Rendering revision {rev}…</div> : isDesktop ? <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
      <p className="small muted" style={{ margin: 0 }}>Interactive previews run in a separate native window with its own non-persistent website data, no network, no navigation, no WebRTC and no access to One Connect. Local links between this revision's pages work inside it.</p>
      <button type="button" className="btn primary" disabled={busy || !preview.shell} onClick={() => void openNative()}>Open interactive preview · {viewport.name} {viewport.width}×{viewport.height}</button>
      {preview.shellError && <span className="small text-warn">{preview.shellError}</span>}
      {opened && <span className="small text-ok" role="status">{opened}</span>}
      <ErrorLine error={error} />
    </div> : <>
      <StaticFrame doc={preview.static} viewport={viewport} title={`${title}: ${page}, revision ${rev}, static render`} />
      <div className="stage-caption"><b>Static layout render</b><span>Scripts, links and forms are disabled. This browser view is not the isolated interactive preview and offers weaker isolation, so mock code never runs here. Open the desktop app to exercise interactions.</span></div>
    </>}
  </section>;
}
