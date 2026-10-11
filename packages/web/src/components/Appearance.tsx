// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Per-device appearance: theme, colour-blind-safe status colours and high contrast. Nothing here goes
// through Decisions or the daemon; it is this browser's preference (see lib/theme.ts).
import { useEffect, useState } from 'react';
import { setContrast, setTheme, setVision, useAppearance, type ContrastChoice, type ThemeChoice, type VisionChoice } from '../lib/theme';
import { onSoundsChange, playSound, readSounds, setSounds, type SoundChoice } from '../lib/sounds';
import { resetSetup, useSetup } from '../lib/setup';

export function Appearance() {
  const a = useAppearance();
  const setup = useSetup();
  const [sounds, setSoundsState] = useState<SoundChoice>(readSounds);
  useEffect(() => onSoundsChange(setSoundsState), []);
  return <section className="card card-b col appearance" aria-labelledby="appearance-h">
    <div className="row"><h2 id="appearance-h">Appearance</h2><span className="spacer"/><span className="small faint">Saved on this device</span>{setup.done && <button type="button" className="btn sm" onClick={resetSetup}>Run setup again</button>}</div>
    <div className="builder-fields">
      <label>Theme<select value={a.theme} onChange={e => setTheme(e.target.value as ThemeChoice)}><option value="machine">Machine (follow system)</option><option value="day">Day</option><option value="night">Night (pitch black)</option></select></label>
      <label>Status colours<select value={a.vision} onChange={e => setVision(e.target.value as VisionChoice)}><option value="standard">Standard (lime, amber, coral, sky)</option><option value="cb">Colour-blind safe (blue, yellow, vermillion, purple)</option></select></label>
      <label>Contrast<select value={a.contrast} onChange={e => setContrast(e.target.value as ContrastChoice)}><option value="standard">Standard</option><option value="high">High (7:1 text, no shadows)</option></select></label>
      <label>UI sounds<select value={sounds} onChange={e => { const v = e.target.value as SoundChoice; setSounds(v); if (v === 'on') playSound('toggle-tick', 0.4); }}><option value="on">On (needs you, run done, alerts, toggles)</option><option value="off">Off</option></select></label>
    </div>
    <div className="row wrap appearance-sample" aria-hidden>
      <span className="badge tone-ok"><span className="light tone-ok"/>running</span>
      <span className="badge tone-warn"><span className="light tone-warn"/>needs you</span>
      <span className="badge tone-crit"><span className="light tone-crit"/>failed</span>
      <span className="badge tone-info"><span className="light tone-info"/>queued</span>
      <span className="badge"><span className="light"/>idle</span>
      <span className="btn primary sm">Approve push</span>
      <span className="btn danger sm">Stop runs</span>
    </div>
    <p className="small faint">Every status also carries a word, so the colour is never the only cue. Reduced motion follows your system setting.</p>
  </section>;
}
