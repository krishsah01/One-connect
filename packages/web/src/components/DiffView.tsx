// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Worktree diff against the assignment's base SHA, refetched when the run reports file changes.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface ChangedFile {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
}

export function DiffView({ assignmentId, version, outOfScope }: { assignmentId: string; version: string; outOfScope: string[] }) {
  const [data, setData] = useState<{ files: ChangedFile[]; patch: string; truncated: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ files: ChangedFile[]; patch: string; truncated: boolean }>(`/api/assignments/${assignmentId}/diff`)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [assignmentId, version]);
  if (error) return <div className="small faint">Diff unavailable: {error}</div>;
  if (!data) return <div className="small faint">Loading diff…</div>;
  if (data.files.length === 0) return <div className="small faint">No changes against the base yet.</div>;
  return (
    <div className="col">
      <table className="table">
        <tbody>
          {data.files.map((f) => (
            <tr key={f.path}>
              <td className="mono" style={{ wordBreak: 'break-all' }}>
                {f.path}
                {outOfScope.includes(f.path) && (
                  <span className="badge tone-crit" style={{ marginLeft: 6 }}>
                    out of scope
                  </span>
                )}
              </td>
              <td className="faint small">{f.status}</td>
              <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                {f.added !== null && <span style={{ color: 'var(--ok)' }}>+{f.added} </span>}
                {f.removed !== null && <span style={{ color: 'var(--crit)' }}>−{f.removed}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn sm" onClick={() => setOpen(!open)} style={{ alignSelf: 'flex-start' }}>
        {open ? 'Hide patch' : 'Show patch'}
      </button>
      {open && (
        <div className="diff">
          {data.patch.split('\n').map((l, i) => (
            <div key={i} className={l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>
              {l || ' '}
            </div>
          ))}
          {data.truncated && <div className="faint">… patch truncated</div>}
        </div>
      )}
    </div>
  );
}
