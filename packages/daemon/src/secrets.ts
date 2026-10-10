// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// API keys for connections the user explicitly opted into (Anthropic Console, OpenAI, OpenRouter,
// Linear). Stored in the macOS Keychain (or ACC_SECRET_<NAME> env vars elsewhere), never in
// config, logs or the event store, and handed only to that connection's own runs.
import { spawn } from 'node:child_process';
import { run } from './exec.ts';

export const KEYCHAIN_SERVICE = 'agent-control-center';
export const SECRET_NAMES = ['anthropic-api', 'openai-api', 'openrouter', 'ollama-cloud', 'jev', 'linear', 'github', 'gitlab', 'vercel', 'supabase', 'github-webhook', 'gitlab-webhook'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const envName = (n: string) => `ACC_SECRET_${n.toUpperCase().replace(/-/g, '_')}`;

export async function getSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env[envName(name)]) return env[envName(name)]!;
  if (name === 'linear' && env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  if (process.platform !== 'darwin') return null;
  const r = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export async function hasSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await getSecret(name, env)) !== null;
}

/** Store via `security -i` on stdin so the key never appears in argv / process listings. */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error(`set ${envName(name)} in the daemon's environment (Keychain storage is macOS-only)`);
  if (!/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('that does not look like an API key');
  await new Promise<void>((resolve, reject) => {
    const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(err.trim() || `security exited ${code}`))));
    p.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w "${value.replace(/"/g, '\\"')}"\n`);
  });
}

export async function deleteSecret(name: SecretName): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name], { timeoutMs: 10_000 });
}

/** Which secret (and env var) each provider's harness needs. */
export const PROVIDER_SECRET: Partial<Record<string, { secret: SecretName; envVars: string[] }>> = {
  'anthropic-api': { secret: 'anthropic-api', envVars: ['ANTHROPIC_API_KEY'] },
  'openai-api': { secret: 'openai-api', envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
  openrouter: { secret: 'openrouter', envVars: ['OPENROUTER_API_KEY'] },
  // Only the cloud-API route needs this key; see providerSecretFor().
  'ollama-cloud': { secret: 'ollama-cloud', envVars: ['OLLAMA_API_KEY'] },
};

/** The Keychain secret an agent's run needs, if any (Ollama cloud through a signed-in local daemon needs none). */
export function providerSecretFor(agent: { provider: string; ollama_route?: string }): { secret: SecretName; envVars: string[] } | undefined {
  if (agent.provider === 'ollama-cloud' && (agent.ollama_route ?? 'daemon') !== 'api') return undefined;
  return PROVIDER_SECRET[agent.provider];
}
