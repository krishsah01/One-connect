// SPDX-License-Identifier: Apache-2.0
export { Daemon, CommandError, VERSION, type DaemonOptions } from './daemon.ts';
export { createServer } from './server/http.ts';
export { loadConfig, findConfig } from './config.ts';
export { VENDOR_ADAPTERS, adapterFor } from './adapters/agents/index.ts';
export type { VendorAdapter, LaunchContext, LaunchSpec, StreamParser, Parsed } from './adapters/agents/types.ts';
export { createTracker, LocalTracker, GitHubTracker, LinearTracker } from './adapters/trackers/index.ts';
export type { TrackerAdapter, TrackerIssue, NewIssue } from './adapters/trackers/types.ts';
