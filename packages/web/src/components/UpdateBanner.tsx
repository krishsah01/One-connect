// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Mac app updates. The native shell checks the signed update feed; this banner offers the restart.
// Nothing downloads until the person presses the button, and the shell stops every project engine
// gracefully before relaunching. After a relaunch into a new version, a one-time note confirms it.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { isDesktop } from '../lib/desktop';
import { playSound } from '../lib/sounds';

interface UpdateInfo { version: string; current: string; notes: string | null; date: string | null }
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const LAST_VERSION = 'one-connect.last-version';

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    // Confirm a completed update once, on the first launch of the new version.
    void getVersion().then(v => {
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_VERSION); localStorage.setItem(LAST_VERSION, v); } catch { /* private storage */ }
      if (active && last && last !== v) { setUpdatedTo(v); playSound('install-complete', 0.5); }
    }).catch(() => { /* version unavailable: skip the note */ });
    const check = () => { void invoke<UpdateInfo | null>('update_check').then(u => { if (active) setUpdate(u); }).catch(() => { /* offline or feed unavailable: try again later */ }); };
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => { active = false; clearTimeout(first); clearInterval(every); };
  }, []);

  if (!isDesktop) return null;
  if (updatedTo) {
    return <div className="shell-note tone-info" role="status"><span><b>Updated to {updatedTo}.</b> Your projects and engines picked up where they left off.</span><span className="spacer" /><button type="button" className="btn sm ghost" onClick={() => setUpdatedTo(null)}>Dismiss</button></div>;
  }
  if (!update || dismissed) return null;
  const install = () => {
    setInstalling(true);
    setError(null);
    invoke('update_install').catch((e: unknown) => { setInstalling(false); setError(e instanceof Error ? e.message : String(e)); });
  };
  return (
    <div className="shell-note tone-info update-note" role="status">
      <span><b>One Connect {update.version} is ready.</b> {installing ? 'Downloading and verifying the update. Your projects stop cleanly, then the app reopens.' : `You have ${update.current}. Restart to update; running agents stop first.`}</span>
      {error && <span className="update-error">{error}</span>}
      <span className="spacer" />
      {!installing && <button type="button" className="btn sm ghost" onClick={() => setDismissed(true)}>Later</button>}
      <button type="button" className="btn sm primary" disabled={installing} onClick={install}>{installing ? 'Updating…' : 'Restart to update'}</button>
    </div>
  );
}
