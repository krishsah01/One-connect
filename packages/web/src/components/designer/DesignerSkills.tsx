// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The pinned skills design agents may load, with their sources and licences. Lives in Settings; the
// Designer itself never shows this table.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Badge, ErrorLine } from '../common';
import { api } from '../../lib/api';
import type { ContractResponse } from './shared';

export function DesignerSkills() {
  const [data, setData] = useState<ContractResponse | null>(null), [err, setErr] = useState('');
  useEffect(() => { let alive = true; void api<ContractResponse>('/api/designer/contract').then(r => alive && setData(r)).catch(e => alive && setErr((e as Error).message)); return () => { alive = false; }; }, []);
  const sets: [string, readonly string[]][] = data ? [['Design', data.skillSets.design], ['Build', data.skillSets.implementation], ['Review', data.skillSets.review]] : [];
  return <section className="card card-b col" aria-labelledby="designer-skills">
    <div className="row"><h2 id="designer-skills">Designer skills</h2><span className="spacer" /><Link to="/skills" className="small">Project skills</Link></div>
    <p className="small muted">Design jobs carry each skill’s one-line description; the agent loads a skill only when it applies. The project design contract, not a skill, controls the visual identity.</p>
    {err && <ErrorLine error={`Could not load skills: ${err}`} />}
    {!data && !err && <p className="small muted" role="status">Loading skills…</p>}
    {data && <details><summary className="small">{data.skills.length} pinned skills and their licences</summary>
      <table className="checks-table" style={{ marginTop: 10 }}><thead><tr><th>Skill</th><th>For</th><th>Source</th><th>Licence</th>{sets.map(([n]) => <th key={n}>{n}</th>)}</tr></thead>
        <tbody>{data.skills.map(s => <tr key={s.id}><td><b>{s.name}</b><br /><code className="faint">{s.id}</code></td><td>{s.purpose}</td><td>{s.source.startsWith('https://') ? <a href={s.source} target="_blank" rel="noreferrer noopener">{s.source.replace('https://github.com/', '')}</a> : s.source}</td><td><Badge>{s.license}</Badge></td>{sets.map(([n, ids]) => <td key={n}>{ids.includes(s.id) ? <Badge tone="ok">yes</Badge> : <span className="faint">—</span>}</td>)}</tr>)}</tbody></table>
      <p className="small muted" style={{ marginTop: 10 }}>Pinned upstream text keeps its notices; hashes are verified on every read. See THIRD_PARTY_NOTICES.md. The review checklist every approval uses: {data.checklist.map(c => c.label).join(', ')}.</p>
    </details>}
  </section>;
}
