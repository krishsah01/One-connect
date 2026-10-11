// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The harnesses a user can choose during setup: where the vendor's own installer lives, which
// terms govern subscription sign-in, and the API-key route that is always allowed. One Connect
// never bundles or downloads a vendor binary itself: the user runs the vendor's installer.
// Reviewed against the vendors' published docs on 2026-10-10. Bump `termsRevision` whenever the
// linked terms change materially: every owner then re-reads and re-confirms before dispatch.
import type { AdapterType, Provider } from '@acc/core';
import { SUPPORTED_VERSIONS } from './adapters/agents/opencode/protocol.ts';

export interface HarnessInstall {
  id: string;
  label: string;
  /** Shown to the user and prepared in the project terminal; never run without them pressing Return. */
  command: string;
  recommended?: boolean;
  note?: string;
}

export interface HarnessEntry {
  adapter: AdapterType;
  displayName: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  install: HarnessInstall[];
  terms: { label: string; url: string }[];
  termsRevision: string;
  /** Own-plan sign-in through the vendor's CLI; null when the harness has no login of its own. */
  subscription: { loginArgs: string[]; plans: string; notes: string[] } | null;
  /** Pay-per-token route billed to the key owner: the safe choice for shared or hosted use. */
  apiKey: { provider: Provider; keyUrl: string; note: string } | null;
  /** macOS Developer ID the vendor signs its CLI with. Null: the vendor ships it unsigned. */
  signer: { teamId: string; organization: string } | null;
}

export const HARNESS_CATALOG: readonly HarnessEntry[] = [
  {
    adapter: 'claude-headless',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    summary: "Anthropic's coding agent. Sign in with your own Claude plan, or use an Anthropic Console API key.",
    docsUrl: 'https://code.claude.com/docs/en/setup',
    install: [
      { id: 'native', label: 'Official installer', command: 'curl -fsSL https://claude.ai/install.sh | bash', recommended: true, note: 'Updates itself in the background.' },
      { id: 'brew', label: 'Homebrew', command: 'brew install --cask claude-code', note: 'Run `brew upgrade claude-code` to update.' },
      { id: 'npm', label: 'npm (Node.js 22+)', command: 'npm install -g @anthropic-ai/claude-code' },
    ],
    terms: [
      { label: 'Claude Code legal and compliance', url: 'https://code.claude.com/docs/en/legal-and-compliance' },
      { label: 'Consumer Terms (Pro, Max)', url: 'https://www.anthropic.com/legal/consumer-terms' },
      { label: 'Commercial Terms (Team, Enterprise, API)', url: 'https://www.anthropic.com/legal/commercial-terms' },
      { label: 'Usage Policy', url: 'https://www.anthropic.com/legal/aup' },
    ],
    termsRevision: '2026-10-10',
    subscription: {
      loginArgs: ['auth', 'login'],
      plans: 'Claude Pro, Max, Team or Enterprise',
      notes: [
        'Anthropic allows you to sign in to the unmodified Claude Code CLI with your own plan.',
        'Plan limits assume ordinary, individual use. Products must not route other people\'s requests through your plan or collect your login tokens.',
      ],
    },
    apiKey: { provider: 'anthropic-api', keyUrl: 'https://platform.claude.com/', note: 'Anthropic bills the key owner per token. Required for anything shared, hosted or run for other people.' },
    signer: { teamId: 'Q6L2SF6YDW', organization: 'Anthropic PBC' },
  },
  {
    adapter: 'codex-cli',
    displayName: 'Codex CLI',
    vendor: 'OpenAI',
    summary: "OpenAI's coding agent. Sign in with your own ChatGPT plan, or use an OpenAI API key.",
    docsUrl: 'https://developers.openai.com/codex/cli',
    install: [
      { id: 'native', label: 'Official installer', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', recommended: true },
      { id: 'brew', label: 'Homebrew', command: 'brew install --cask codex' },
      { id: 'npm', label: 'npm', command: 'npm install -g @openai/codex' },
    ],
    terms: [
      { label: 'OpenAI Terms of Use', url: 'https://openai.com/policies/terms-of-use/' },
      { label: 'OpenAI Service Terms', url: 'https://openai.com/policies/service-terms/' },
      { label: 'OpenAI Usage Policies', url: 'https://openai.com/policies/usage-policies/' },
    ],
    termsRevision: '2026-10-10',
    subscription: {
      loginArgs: ['login'],
      plans: 'ChatGPT Plus, Pro, Business, Edu or Enterprise',
      notes: ['ChatGPT sign-in uses your plan\'s included Codex usage. Accounts are personal: do not share a login.'],
    },
    apiKey: { provider: 'openai-api', keyUrl: 'https://platform.openai.com/api-keys', note: 'OpenAI bills the key owner per token, separately from ChatGPT.' },
    signer: { teamId: '2DC432GLL2', organization: 'OpenAI OpCo, LLC' },
  },
  {
    adapter: 'cursor-agent-cli',
    displayName: 'Cursor Agent CLI',
    vendor: 'Cursor (Anysphere)',
    summary: "Cursor's coding agent. Sign in with your own Cursor plan, or use a Cursor API key.",
    docsUrl: 'https://cursor.com/docs/cli/installation',
    install: [{ id: 'native', label: 'Official installer', command: 'curl https://cursor.com/install -fsS | bash', recommended: true, note: 'Installs to ~/.local/bin. Add it to your PATH if needed.' }],
    terms: [
      { label: 'Cursor Terms of Service', url: 'https://cursor.com/terms-of-service' },
      { label: 'Cursor CLI authentication', url: 'https://cursor.com/docs/cli/reference/authentication' },
    ],
    termsRevision: '2026-10-10',
    subscription: {
      loginArgs: ['login'],
      plans: 'Cursor Pro, Pro+, Ultra or Teams',
      notes: ['Cursor plan logins are personal. Usage-based (on-demand) billing is an account setting the CLI cannot report.'],
    },
    apiKey: { provider: 'cursor-api', keyUrl: 'https://cursor.com/dashboard', note: 'Create the key under API Keys in your Cursor dashboard. Cursor bills the key owner.' },
    signer: null,
  },
  {
    adapter: 'opencode-server',
    displayName: 'OpenCode',
    vendor: 'OpenCode (MIT open source)',
    summary: 'Open-source harness for API keys and local models (Ollama). It has no login of its own; each provider bills its own key.',
    docsUrl: 'https://opencode.ai/docs/',
    install: [
      { id: 'npm', label: `npm (pinned ${SUPPORTED_VERSIONS[0]})`, command: `npm install -g opencode-ai@${SUPPORTED_VERSIONS[0]}`, recommended: true, note: 'One Connect accepts only the pinned OpenCode release.' },
      { id: 'brew', label: 'Homebrew tap', command: 'brew install anomalyco/tap/opencode', note: `Installs the newest release; One Connect refuses releases other than ${SUPPORTED_VERSIONS.join(', ')}.` },
    ],
    terms: [{ label: 'OpenCode package and MIT license', url: 'https://www.npmjs.com/package/opencode-ai' }],
    termsRevision: '2026-10-10',
    subscription: null,
    apiKey: null,
    signer: null,
  },
];

export function harnessEntry(adapter: string): HarnessEntry | undefined {
  return HARNESS_CATALOG.find((h) => h.adapter === adapter);
}

/** Generic CLIs have no catalog entry; their owner confirms the same rules against their vendor. */
export function termsRevisionFor(adapter: string): string {
  return harnessEntry(adapter)?.termsRevision ?? 'generic-2026-10-10';
}
