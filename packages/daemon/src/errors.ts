// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Errors a command reports to its caller. The HTTP layer turns a CommandError into its status
// code and message; anything else is a 500.

export class CommandError extends Error {
  status: number;
  /** Structured validation problems (e.g. workflow issues), returned to the client as-is. */
  issues?: unknown[];
  constructor(message: string, status = 400, issues?: unknown[]) {
    super(message);
    this.status = status;
    if (issues) this.issues = issues;
  }
}
