// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Quick switch between added projects (desktop app); other projects keep running in the background.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAction } from '../components/common';
import { DEMO_PROJECT, listProjects, useActiveProject, type ProjectList } from '../lib/desktop';
import { openProject } from '../lib/store';

export function ProjectSwitcher() {
  const active = useActiveProject();
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { const load = () => void listProjects().then(setList).catch(() => {}); load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [active?.project]);
  const options = [...(list?.projects ?? []).map(p => ({ id: p.id, label: `${p.running ? '● ' : ''}${p.name}` })), { id: DEMO_PROJECT, label: `${list?.demo.running ? '● ' : ''}Offline demo` }];
  return <div className="col" style={{ gap: 4 }}>
    <select aria-label="Switch project" disabled={busy} value={active?.project ?? ''} onChange={e => { const id = e.target.value; if (id === '__manage') navigate('/projects'); else void run(() => openProject(id)); }}>
      {active && !options.some(o => o.id === active.project) && <option value={active.project}>{active.name}</option>}
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      <option value="__manage">Add or manage projects…</option>
    </select>
    {error && <span className="small" role="alert">{error}</span>}
  </div>;
}
