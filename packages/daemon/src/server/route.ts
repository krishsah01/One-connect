// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared shapes for HTTP route modules. Each module registers one domain's routes; http.ts owns
// only the security boundary, the socket and the static UI.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CommandError, type Daemon } from '../daemon.ts';

/** Registers one domain's routes; awaited in order, its return value is ignored. */
export type RouteModule = (app: FastifyInstance, d: Daemon) => unknown;

/** A typed request: body, `:id`-style params and query string. */
export type Req<Body = unknown, Params = { id: string }, Query = Record<string, string | undefined>> = FastifyRequest<{ Body: Body; Params: Params; Querystring: Query }>;

/** Validate a request body (a missing body counts as `{}`); a mismatch is a 400 that names the field. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  throw new CommandError(`Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
}
