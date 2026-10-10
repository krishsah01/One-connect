// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const WorkflowLinkInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  from: z.string().min(1).max(100),
  to: z.array(z.string().min(1).max(100)).min(1).max(8),
  gate: z.object({
    kind: z.enum(['human', 'jev']), question: z.string().trim().min(1).max(500),
    options: z.array(z.object({ label: z.string().trim().min(1).max(120), to: z.string().min(1).max(100) }).strict()).min(2).max(8),
    jev: z.object({ autoDecide: z.boolean(), host: z.string().min(1).max(253), maxEvidenceBytes: z.number().int().min(1).max(24000), confirmedAt: z.string().datetime(), confirmedBy: z.string().min(1).max(100) }).strict().nullable().optional(),
  }).strict().nullable(),
}).strict();
export type WorkflowLinkInput = z.infer<typeof WorkflowLinkInputSchema>;
export interface WorkflowLink {
  id: string;
  from: string;
  to: string[];
  gate: WorkflowLinkInput['gate'];
  status: 'waiting' | 'open' | 'decided' | 'started' | 'canceled';
  decision: { option: string; by: 'human' | 'jev'; at: string; advisoryId?: string } | null;
  decisionId: string | null;
  /** Prevent a saved gate from starting a subsequently edited target. */
  targetVersions: Record<string, number>;
  /** Appended atomically with each target's running event, so restart cannot dispatch it twice. */
  started: string[];
  jevAttempted: boolean;
  reason: string | null;
}
