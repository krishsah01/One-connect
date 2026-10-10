#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Stage the bundled local models into the desktop app's resources. The files must already be in
// .desktop-cache/models (downloaded once, with the owner's approval) and are verified against the
// pinned SHA-256 values before they are copied. Nothing is downloaded here.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.desktop-cache/models');
const out = path.join(root, 'packages/desktop/src-tauri/resources/models');
const PINNED = {
  'llama-b11540-bin-macos-arm64.tar.gz': 'c1adba5ad91539a50d54d8fbec21681dfb36a33048e79e3753ee665dbaf50b2e',
  'Qwen3-Embedding-0.6B-Q8_0.gguf': '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
  'Qwen3-1.7B-Q8_0.gguf': '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
};
const sha = file => new Promise((resolve, reject) => { const h = createHash('sha256'); fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });

for (const [name, expected] of Object.entries(PINNED)) {
  const file = path.join(cache, name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. The bundled models are downloaded once into .desktop-cache/models; see docs/local-models.md.`);
  const actual = await sha(file);
  if (actual !== expected) throw new Error(`${name} SHA-256 mismatch: ${actual}`);
}
const llama = path.join(cache, 'llama/llama-b11540');
if (!fs.existsSync(path.join(llama, 'llama-server'))) throw new Error('Unpack llama-b11540-bin-macos-arm64.tar.gz into .desktop-cache/models/llama first.');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'llama'), { recursive: true });
fs.cpSync(llama, path.join(out, 'llama/llama-b11540'), { recursive: true });
for (const name of ['Qwen3-1.7B-Q8_0.gguf', 'Qwen3-Embedding-0.6B-Q8_0.gguf']) {
  // A copy-on-write clone where the file system supports it; a plain copy otherwise.
  fs.copyFileSync(path.join(cache, name), path.join(out, name), fs.constants.COPYFILE_FICLONE);
}
fs.writeFileSync(path.join(out, 'NOTICE.md'), `# Bundled local models

- Qwen3-1.7B (Q8_0 GGUF), Apache-2.0, https://huggingface.co/Qwen/Qwen3-1.7B-GGUF, SHA-256 ${PINNED['Qwen3-1.7B-Q8_0.gguf']}
- Qwen3-Embedding-0.6B (Q8_0 GGUF), Apache-2.0, https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF, SHA-256 ${PINNED['Qwen3-Embedding-0.6B-Q8_0.gguf']}
- llama.cpp llama-server build b11540 (macOS arm64), MIT, https://github.com/ggml-org/llama.cpp (license in llama/llama-b11540/LICENSE)

They run only on this Mac, on 127.0.0.1. Nothing is downloaded at run time and no other model is used.
`);
console.log(`Staged bundled models at ${out}`);
