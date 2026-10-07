// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { normalizeComposeProject } from '../environment/compose.ts';
import { executeClone, executeGitInit, planClone, planGitInit } from './clone.ts';
import { inspectProject, ProjectIntakeError } from './inspect.ts';
import { prepareProject } from './prepare.ts';

export type ProjectCommandResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

/** Identity the native registry records: the config's exact, resolved repository binding. */
export function describeConfig(file: string) {
  if (!path.isAbsolute(file)) throw new ProjectIntakeError('Configuration path must be absolute');
  const config = fs.realpathSync(file);
  const cfg = loadConfig(config);
  let repo: string;
  try { repo = fs.realpathSync(cfg.project.repo); } catch { throw new ProjectIntakeError(`project.repo ${cfg.project.repo} does not exist`); }
  return { config, name: cfg.project.name, repo, dockerProject: normalizeComposeProject(cfg.project.docker_project ?? cfg.project.name) };
}

export async function projectCommand(sub: string, flag: (name: string) => string | undefined): Promise<ProjectCommandResult> {
  const need = (name: string) => {
    const v = flag(name);
    if (!v) throw new ProjectIntakeError(`--${name} is required`);
    return v;
  };
  try {
    switch (sub) {
      case 'inspect': return { ok: true, inspection: await inspectProject(need('dir')) };
      case 'prepare': {
        const prepared = await prepareProject(need('dir'), need('config-dir'), { name: flag('name') });
        const project = describeConfig(prepared.config);
        if (project.repo !== prepared.inspection.path) throw new ProjectIntakeError('The configuration does not bind the selected folder.');
        return { ok: true, ...prepared, project };
      }
      case 'describe-config': return { ok: true, project: describeConfig(need('config')) };
      case 'clone-plan': return { ok: true, plan: planClone(need('url'), need('parent'), flag('name')) };
      case 'clone': return { ok: true, inspection: await executeClone(need('url'), need('parent'), flag('name'), need('digest')) };
      case 'init-plan': return { ok: true, plan: await planGitInit(need('dir')) };
      case 'init': return { ok: true, inspection: await executeGitInit(need('dir'), need('digest')) };
      default: throw new ProjectIntakeError('Use inspect, prepare, describe-config, clone-plan, clone, init-plan or init');
    }
  } catch (e) {
    return { ok: false, error: e instanceof ProjectIntakeError ? e.message : `Project command failed: ${(e as Error).message.split('\n')[0]}` };
  }
}
