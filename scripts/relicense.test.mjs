// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// node --test scripts/relicense.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NEW, relicense } from './relicense.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relicense-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('package.json', '{\n  "name": "x",\n  "license": "Apache-2.0"\n}\n');
  put('packages/a/src/index.ts', '// SPDX-License-Identifier: Apache-2.0\nexport const a = 1;\n');
  put('packages/a/src/style.css', '/* SPDX-License-Identifier: Apache-2.0 */\n.a {}\n');
  put('packages/a/test/fixtures/own.ts', '// SPDX-License-Identifier: Apache-2.0\n// our own fixture\n');
  put('packages/a/test/fixtures/real/vendor.ts', '// SPDX-License-Identifier: Apache-2.0\n// recorded third-party fixture\n');
  put('packages/daemon/resources/designer/skill.md', 'SPDX-License-Identifier: Apache-2.0\nMIT upstream\n');
  put('packages/a/src/mit.ts', '// SPDX-License-Identifier: MIT\nexport {};\n');
  put('src-tauri/Cargo.toml', '[package]\nname = "x"\nlicense = "Apache-2.0"\n');
  put('LICENSE', '                                 Apache License\n');
  put('NOTICE', 'One Connect\n\nThis product is licensed under the Apache License, Version 2.0 (see LICENSE).\n');
  put('README.md', '## License\n\n[Apache License 2.0](LICENSE). See NOTICE.\n');
  execFileSync('git', ['init', '-q', root]);
  return root;
}

test('relicenses own headers and fields, leaves third-party files alone, and is idempotent', () => {
  const root = fixture();
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const dry = relicense(root, { write: false });
  assert.ok(dry.includes('packages/a/src/index.ts'));
  assert.equal(read('packages/a/src/index.ts').includes(NEW), false, 'dry run writes nothing');
  relicense(root);
  assert.match(read('packages/a/src/index.ts'), new RegExp(`^// SPDX-License-Identifier: ${NEW}\n`));
  assert.match(read('packages/a/src/style.css'), new RegExp(`^/\\* SPDX-License-Identifier: ${NEW} \\*/`));
  assert.match(read('package.json'), new RegExp(`"license": "${NEW}"`));
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`license = "${NEW}"`));
  assert.match(read('LICENSE'), /^"Commons Clause" License Condition v1\.0[\s\S]*Software: One Connect[\s\S]*Apache License/);
  assert.match(read('NOTICE'), /Commons Clause/);
  assert.match(read('README.md'), /not an OSI open-source license/);
  assert.ok(fs.existsSync(path.join(root, 'LICENSES/LicenseRef-Commons-Clause-1.0.txt')));
  // Third-party files, fixtures and other licenses keep theirs.
  assert.match(read('packages/a/test/fixtures/own.ts'), new RegExp(`Identifier: ${NEW}`));
  assert.match(read('packages/a/test/fixtures/real/vendor.ts'), /Identifier: Apache-2\.0\n/);
  assert.match(read('packages/daemon/resources/designer/skill.md'), /Identifier: Apache-2\.0\n/);
  assert.match(read('packages/a/src/mit.ts'), /Identifier: MIT/);
  assert.deepEqual(relicense(root, { write: false }), [], 'second run changes nothing');
});
