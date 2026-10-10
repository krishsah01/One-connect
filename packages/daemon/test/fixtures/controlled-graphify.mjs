#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Test-only Graphify stand-in whose `update` can fail or stall, selected by a mode file named in
// DICTIONARY_GRAPH_MODE_FILE (contents: ok | fail | slow). Delegates to fake-graphify otherwise.
import fs from 'node:fs';
const modeFile = process.env.DICTIONARY_GRAPH_MODE_FILE;
const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';
if (process.argv[2] === 'update' && mode === 'fail') { console.error('fixture: graph build failed'); process.exit(3); }
if(process.argv[2]==='update'&&['malformed','invalid-shape'].includes(mode)){
  fs.mkdirSync('graphify-out',{recursive:true});
  fs.writeFileSync('graphify-out/graph.json',mode==='malformed'?'not JSON':JSON.stringify({nodes:42,links:[]}));
  process.exit(0);
}
if (process.argv[2] === 'update' && mode === 'slow') await new Promise((r) => setTimeout(r, 30_000));
await import('./fake-graphify.mjs');
