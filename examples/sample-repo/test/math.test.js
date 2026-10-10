// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, mul } from '../src/math.js';

test('add', () => assert.equal(add(2, 3), 5));
test('mul', () => assert.equal(mul(2, 3), 6));
