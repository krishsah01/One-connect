/* SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0 */
/* One Connect site. React 18 + Framer Motion (UMD) from the CDN, no build step. */
(function () {
  var R = window.React, D = window.ReactDOM, M = window.Motion;
  var h = R.createElement, useState = R.useState, useEffect = R.useEffect, useRef = R.useRef;
  var motion = M.motion, AnimatePresence = M.AnimatePresence, useReducedMotion = M.useReducedMotion;
  var EASE = [0.2, 0, 0, 1], SPRING = { type: 'spring', stiffness: 520, damping: 34, mass: 0.8 };

  function Reveal(p) {
    var reduce = useReducedMotion();
    var el = motion[p.as || 'div'];
    return h(el, { className: p.className, initial: reduce ? false : { y: 12 }, whileInView: { y: 0 }, viewport: { once: true, margin: '-40px' }, transition: { duration: 0.32, ease: EASE, delay: p.delay || 0 } }, p.children);
  }
  function Badge(p) { return h('span', { className: 'pill ' + (p.tone || '') }, p.dot ? h('span', { className: 'dot' }) : null, p.children); }

  // ---- Hero scene: three agents, a live log, one approval you can answer ----
  var AGENTS = [{ name: 'Claude Code', issue: 'ONE-142', hue: 'grape' }, { name: 'Codex', issue: 'ONE-139', hue: 'accent' }, { name: 'Cursor', issue: 'ONE-151', hue: 'sun' }];
  var SCRIPT = [
    { t: '12:04:11', k: 'run.started', who: 'codex', what: 'ONE-139 · worktree acc/ONE-139' },
    { t: '12:06:02', k: 'run.started', who: 'cursor', what: 'ONE-151 · worktree acc/ONE-151' },
    { t: '12:09:40', k: 'review.opened', who: 'claude-code', what: 'ONE-142 · 3 commits' },
    { t: '12:09:41', k: 'approval.requested', who: 'claude-code', what: 'push to main', ask: true },
    { t: '12:14:55', k: 'handoff.created', who: 'codex → cursor', what: 'ONE-139 · tests' },
    { t: '12:15:20', k: 'alert.stall', who: 'rules', what: 'cursor idle 15 min with work queued', tone: 'warn' },
    { t: '12:15:21', k: 'queue.next', who: 'cursor', what: 'ONE-151 → ONE-139' },
  ];
  function LogScene() {
    var reduce = useReducedMotion();
    var _i = useState(reduce ? SCRIPT.length : 0), i = _i[0], setI = _i[1];
    var _ans = useState(null), answered = _ans[0], setAnswered = _ans[1];
    useEffect(function () {
      if (reduce) return;
      if (i >= SCRIPT.length) return;
      var id = setTimeout(function () { setI(i + 1); }, i === 0 ? 600 : 1500);
      return function () { clearTimeout(id); };
    }, [i, reduce]);
    var events = SCRIPT.slice(0, i);
    var ask = i > 3 && !answered;
    var rows = events.slice();
    if (answered) rows.push({ t: '12:10:02', k: 'decision.recorded', who: 'you · phone', what: answered === 'approve' ? 'approve push to main' : 'hold push', tone: 'ok' });
    rows = rows.slice(-6);
    var status = function (a) {
      if (a.name === 'Claude Code') return i < 3 ? ['running', 'ok'] : (answered ? ['running', 'ok'] : ['needs you', 'warn']);
      if (a.name === 'Codex') return i < 1 ? ['idle', ''] : i < 5 ? ['running', 'ok'] : ['handed off', 'info'];
      return i < 2 ? ['idle', ''] : i < 6 ? ['running', 'ok'] : ['next started', 'ok'];
    };
    return h('div', { className: 'scene' },
      h('div', { className: 'scene-agents' }, AGENTS.map(function (a) {
        var s = status(a);
        return h(motion.div, { key: a.name, className: 'agent', layout: true, transition: SPRING },
          h('span', { className: 'avatar ' + a.hue }, a.name[0]),
          h('span', { className: 'agent-name' }, a.name),
          h('span', { className: 'agent-issue mono' }, a.issue),
          h(AnimatePresence, { mode: 'popLayout', initial: false },
            h(motion.span, { key: s[0], initial: { opacity: 0, scale: 0.9 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.9 }, transition: { duration: 0.2, ease: EASE } }, h(Badge, { tone: s[1], dot: true }, s[0]))));
      })),
      h('div', { className: 'scene-log' },
        h('div', { className: 'scene-log-h' }, h('span', { className: 'overline' }, 'Event log'), h('span', { className: 'mono faint' }, 'append-only')),
        h(AnimatePresence, { initial: false }, rows.map(function (e) {
          return h(motion.div, { key: e.k + e.t, className: 'ev' + (e.tone ? ' ' + e.tone : ''), layout: true, initial: { opacity: 0, x: -8 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0 }, transition: { duration: 0.22, ease: EASE } },
            h('span', { className: 'mono faint' }, e.t), h('span', { className: 'mono ev-k' }, e.k), h('span', { className: 'ev-who' }, e.who), h('span', { className: 'ev-what' }, e.what));
        })),
        h(AnimatePresence, null, ask ? h(motion.div, { key: 'ask', className: 'ask', initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: SPRING },
          h('span', { className: 'who' }, 'Claude Code · ONE-142 · needs you'),
          h('span', { className: 'q' }, 'Push 3 commits to main?'),
          h('div', { className: 'answers' },
            h(motion.button, { className: 'btn primary', whileTap: { scale: 0.97 }, onClick: function () { setAnswered('approve'); } }, 'Approve push'),
            h(motion.button, { className: 'btn', whileTap: { scale: 0.97 }, onClick: function () { setAnswered('hold'); } }, 'Hold'))) : null),
        i >= SCRIPT.length && !ask ? h('button', { className: 'replay', onClick: function () { setI(0); setAnswered(null); } }, 'Replay') : null));
  }

  // ---- How it works: a path that draws itself ----
  var STEPS = [['Issue', 'from GitHub, Linear or the board'], ['Agent', 'own worktree, own console'], ['Review', 'diff, tests, findings'], ['You', 'approve on desk or phone'], ['Log', 'one append-only record']];
  function Flow() {
    var reduce = useReducedMotion();
    var xs = [60, 270, 480, 690, 900];
    return h('div', { className: 'flow' },
      h('svg', { viewBox: '0 0 960 160', className: 'flow-svg', 'aria-hidden': true },
        h(motion.path, { d: 'M60 80 H900', className: 'flow-line', initial: reduce ? false : { pathLength: 0 }, whileInView: { pathLength: 1 }, viewport: { once: true }, transition: { duration: 1.1, ease: EASE } }),
        xs.map(function (x, k) {
          return h(motion.g, { key: k, initial: reduce ? false : { scale: 0.6, opacity: 0 }, whileInView: { scale: 1, opacity: 1 }, viewport: { once: true }, transition: Object.assign({}, SPRING, { delay: 0.15 + k * 0.18 }), style: { transformBox: 'fill-box', transformOrigin: 'center' } },
            h('circle', { cx: x, cy: 80, r: 22, className: 'flow-node n' + k }),
            k === 3 ? h('path', { d: 'M' + (x - 7) + ' 80 l5 5 l10 -11', className: 'flow-check' }) : null);
        })),
      h('ol', { className: 'flow-steps' }, STEPS.map(function (s, k) {
        return h(Reveal, { key: s[0], as: 'li', delay: 0.2 + k * 0.12 }, h('b', null, s[0]), h('span', null, s[1]));
      })));
  }

  // ---- Guards: four tiles that move ----
  function Stall() {
    var reduce = useReducedMotion();
    return h('div', { className: 'mini' },
      h(motion.div, { className: 'mini-bar', animate: reduce ? {} : { scaleX: [0, 1, 1] }, transition: { duration: 3.2, times: [0, 0.75, 1], repeat: Infinity, repeatDelay: 0.8, ease: 'linear' } }),
      h(motion.span, { className: 'pill warn', animate: reduce ? {} : { opacity: [0, 0, 1, 1] }, transition: { duration: 3.2, times: [0, 0.74, 0.8, 1], repeat: Infinity, repeatDelay: 0.8 } }, 'stall · 15 min'));
  }
  function Drift() {
    var reduce = useReducedMotion();
    return h('div', { className: 'mini drift' },
      h('span', { className: 'pill ok' }, 'board · done'),
      h(motion.span, { className: 'pill', animate: reduce ? {} : { x: [0, 18, 0], opacity: [1, 0.5, 1] }, transition: { duration: 2.6, repeat: Infinity, repeatDelay: 1, ease: EASE } }, 'github · done'));
  }
  function Limit() {
    var reduce = useReducedMotion();
    return h('div', { className: 'mini' },
      h('div', { className: 'meter' }, h(motion.div, { className: 'meter-fill', animate: reduce ? { scaleX: 1 } : { scaleX: [0.2, 1, 1] }, transition: { duration: 3, times: [0, 0.7, 1], repeat: Infinity, repeatDelay: 1, ease: 'linear' } })),
      h(motion.span, { className: 'pill info', animate: reduce ? {} : { opacity: [0, 0, 1, 1] }, transition: { duration: 3, times: [0, 0.7, 0.76, 1], repeat: Infinity, repeatDelay: 1 } }, 'reassign · never paid fallback'));
  }
  function Reach() {
    var reduce = useReducedMotion();
    return h('div', { className: 'mini reach' },
      h('span', { className: 'mono' }, 'git push origin main'),
      h(motion.span, { className: 'pill crit', animate: reduce ? {} : { scale: [0.9, 1, 1] }, transition: { duration: 2.4, times: [0, 0.2, 1], repeat: Infinity, repeatDelay: 1.2, ease: EASE } }, 'routed to you'));
  }
  var GUARDS = [['Silent stalls', 'No events for N minutes raises an alert.', Stall], ['Tracker drift', 'Status and tracker commit together.', Drift], ['Usage limits', 'Hit a limit, get a reassignment.', Limit], ['Unsafe reach', 'Push, deploy, migrate: yours to approve.', Reach]];

  // ---- The house toggle ----
  function Toggle(p) {
    var _s = useState(p.on), on = _s[0], setOn = _s[1];
    var _m = useState(''), moving = _m[0], setMoving = _m[1];
    var _pr = useState(false), pressed = _pr[0], setPressed = _pr[1];
    var timer = useRef(null);
    useEffect(function () { return function () { if (timer.current) clearTimeout(timer.current); }; }, []);
    function flip() { setMoving(on ? 'moving-off' : 'moving-on'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(function () { setMoving(''); }, 200); setOn(!on); }
    return h('label', { className: 'switch-row' },
      h('button', { type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': p.label, className: 'toggle ' + (p.feel || '') + (on ? ' on' : '') + (moving ? ' ' + moving : '') + (pressed ? ' pressed' : ''), onPointerDown: function () { setPressed(true); }, onPointerUp: function () { setPressed(false); }, onPointerLeave: function () { setPressed(false); }, onClick: flip }),
      h('span', null, p.label));
  }

  function Copy(p) {
    var _c = useState(false), ok = _c[0], setOk = _c[1];
    return h('button', { className: 'copy', onClick: function () { try { navigator.clipboard.writeText(p.text).then(function () { setOk(true); setTimeout(function () { setOk(false); }, 1400); }); } catch (e) { /* select fallback */ } } }, ok ? 'Copied' : 'Copy');
  }

  function App() {
    return h(R.Fragment, null,
      h('header', { className: 'nav' }, h('div', { className: 'wrap' },
        h('a', { className: 'brand', href: '#top', 'aria-label': 'One Connect home' }, h('img', { className: 'light', src: 'assets/one-connect-mark.svg', alt: '', width: 28, height: 28 }), h('img', { className: 'dark', src: 'assets/one-connect-mark-on-dark.svg', alt: '', width: 28, height: 28 }), 'One Connect'),
        h('nav', { 'aria-label': 'Site' }, h('a', { href: 'https://github.com/krishsah01/One-connect/tree/main/docs' }, 'Docs'), h('a', { href: 'https://github.com/krishsah01/One-connect' }, 'GitHub'), h('a', { className: 'btn primary', href: '#download' }, 'Download for Mac')))),
      h('main', { id: 'top' },
        h('section', { className: 'hero' }, h('div', { className: 'wrap' },
          h('div', { className: 'hero-copy' },
            h('span', { className: 'overline' }, h('span', { className: 'dot ok' }), 'Development preview · macOS'),
            h('h1', { className: 'display' }, 'Your agents. Your subscriptions. One log.'),
            h('p', { className: 'lede' }, 'Claude Code, Codex and Cursor as one team, on the plans you already pay for.'),
            h('div', { className: 'cta' }, h('a', { className: 'btn primary', href: '#download' }, 'Download for Mac ', h('span', { className: 'new' }, 'Apple silicon')), h('a', { className: 'btn ghost', href: 'https://github.com/krishsah01/One-connect' }, 'View on GitHub'), h('span', { className: 'small' }, 'Free and open source. No account, no API keys.'))),
          h('div', { className: 'hero-scene' }, h(LogScene)))),
        h('div', { className: 'proof' }, h('div', { className: 'wrap' }, ['Official vendor CLIs', 'Runs on 127.0.0.1', 'Append-only log in SQLite', 'Metered billing blocked'].map(function (t) { return h('span', { key: t }, t); }))),
        h('section', { className: 'block', id: 'how' }, h('div', { className: 'wrap' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'How it works'), h('h2', { className: 'title' }, 'An issue goes in. A record comes out.')),
          h(Flow))),
        h('section', { className: 'block', id: 'guards' }, h('div', { className: 'wrap' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'Guards'), h('h2', { className: 'title' }, 'The failures that happen with a team of agents, made loud.')),
          h('div', { className: 'cards' }, GUARDS.map(function (g, k) {
            return h(Reveal, { key: g[0], delay: k * 0.08 }, h('article', { className: 'card guard' }, h(g[2]), h('h3', null, g[0]), h('p', null, g[1])));
          })))),
        h('section', { className: 'block', id: 'subscriptions' }, h('div', { className: 'wrap two' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'Bring your own subscriptions'), h('h2', { className: 'title' }, 'Official CLIs. Your logins. Nothing pooled.'), h('p', { className: 'lede' }, 'One Connect never stores vendor credentials and ships no vendor binaries.')),
          h(Reveal, { className: 'chips big' }, ['Claude Code', 'Codex', 'Cursor', 'Antigravity', 'Gemini app', 'Any CLI'].map(function (v, k) {
            return h(motion.span, { key: v, className: 'chip' + (k < 3 ? ' on' : ''), whileHover: { y: -2 }, transition: { duration: 0.15 } }, v);
          })))),
        h('section', { className: 'block feel', id: 'feel' }, h('div', { className: 'wrap two' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'Feel'), h('h2', { className: 'title' }, 'Nothing takes longer than a quarter of a second.'), h('p', { className: 'lede' }, 'Press and hold a switch. It presses in, stretches, and settles on a spring.')),
          h(Reveal, { className: 'feel-demo' }, h(Toggle, { label: 'Balanced', on: true }), h(Toggle, { label: 'Firm', feel: 'firm', on: false }), h(Toggle, { label: 'Elastic', feel: 'elastic', on: true })))),
        h('section', { className: 'block oss', id: 'open-source' }, h('div', { className: 'wrap two' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'Open source'), h('h2', { className: 'title' }, 'Built in the open.'), h('div', { className: 'cta' }, h('a', { className: 'btn', href: 'https://github.com/krishsah01/One-connect' }, 'Star on GitHub'), h('a', { className: 'btn ghost', href: 'https://github.com/krishsah01/One-connect/blob/main/LICENSE' }, 'Licence'))),
          h(Reveal, { className: 'repo' },
            h('div', { className: 'row' }, h('strong', { className: 'mono' }, 'krishsah01/One-connect'), h('span', { className: 'pill accent' }, 'Apache-2.0 + Commons Clause'), h('span', { className: 'pill ok' }, 'TypeScript · Rust')),
            h('div', { className: 'cmd' }, h('pre', null, 'pnpm install\npnpm demo   ', h('span', { className: 'c' }, '# scripted agents, zero usage')), h(Copy, { text: 'pnpm install && pnpm demo' }))))),
        h('section', { className: 'block download', id: 'download' }, h('div', { className: 'wrap' },
          h(Reveal, { className: 'head' }, h('span', { className: 'overline' }, 'Download'), h('h2', { className: 'title' }, 'Get One Connect for Mac.'),
            h('div', { className: 'cta' }, h('a', { className: 'btn primary', href: 'https://github.com/krishsah01/One-connect/releases' }, 'Download for Mac ', h('span', { className: 'new' }, 'Apple silicon')), h('a', { className: 'btn ghost', href: 'https://github.com/krishsah01/One-connect/blob/main/docs/desktop.md' }, 'Build it yourself')),
            h('span', { className: 'soon' }, 'Web version: in the works.')),
          h(Reveal, { className: 'reqs-wrap' }, h('ul', { className: 'reqs' }, ['macOS 12 or later', 'Node 24+, pnpm, git', 'Your vendor CLIs, signed in', 'Docker for the project you develop'].map(function (t) { return h('li', { key: t }, t); })))))),
      h('footer', null, h('div', { className: 'wrap' },
        h('svg', { viewBox: '0 0 512 512', fill: 'none', stroke: 'currentColor', 'aria-hidden': true }, h('path', { d: 'M168 256 L344 136 M168 256 L344 376', strokeWidth: 26, strokeLinecap: 'round' }), h('circle', { cx: 168, cy: 256, r: 66, strokeWidth: 22 }), h('circle', { cx: 344, cy: 136, r: 48, strokeWidth: 22 }), h('circle', { cx: 344, cy: 376, r: 48, strokeWidth: 22 })),
        h('span', null, 'One Connect · Apache-2.0 with the Commons Clause'),
        h('nav', { 'aria-label': 'Footer' }, h('a', { href: 'https://github.com/krishsah01/One-connect/tree/main/docs' }, 'Docs'), h('a', { href: 'https://github.com/krishsah01/One-connect' }, 'GitHub'), h('a', { href: 'https://github.com/krishsah01/One-connect/blob/main/SECURITY.md' }, 'Security')))));
  }
  D.createRoot(document.getElementById('root')).render(h(App));
})();
