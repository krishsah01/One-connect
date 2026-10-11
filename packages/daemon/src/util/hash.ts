// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The one SHA-256 helper. Decisions, bindings, caches and content-addressed files all hash through
// here so the encoding (hex) and the canonical form of structured values never drift apart.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@acc/core';

/** Hex SHA-256 of text or bytes. */
export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hex SHA-256 of a structured value in canonical (key-sorted) JSON. */
export function sha256Canonical(value: unknown): string {
  return sha256(canonicalJson(value));
}
