// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { post } from '../lib/api';
import { ErrorLine, useAction } from './common';

export function NewIssueDialog({ onClose, trackerTarget }: { onClose: () => void; trackerTarget: string }) {
  const { busy, error, run } = useAction();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [labels, setLabels] = useState('');
  const [priority, setPriority] = useState(3);
  const submit = () =>
    run(async () => {
      await post('/api/issues', {
        title,
        description,
        acceptance: acceptance.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean),
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        priority,
      });
      onClose();
    });
  return (
    <div className="modal-bg" onClick={onClose}>
      <form
        className="card modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="card-h">
          <h2>New issue</h2>
          <span className="spacer" />
          <span className="small faint">created in {trackerTarget}</span>
        </div>
        <div className="card-b col" style={{ gap: 12 }}>
          <label className="field">
            Title
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            Description
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} style={{ fontFamily: 'var(--sans)', fontSize: 13 }} />
          </label>
          <label className="field">
            Acceptance criteria (one per line)
            <textarea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          </label>
          <div className="row" style={{ gap: 12 }}>
            <label className="field grow">
              Labels (comma separated)
              <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, schema" />
            </label>
            <label className="field" style={{ width: 130 }}>
              Priority
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                <option value={1}>1 urgent</option>
                <option value={2}>2 high</option>
                <option value={3}>3 medium</option>
                <option value={4}>4 low</option>
              </select>
            </label>
          </div>
          <ErrorLine error={error} />
          <div className="row">
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !title.trim()}>
              Create issue
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
