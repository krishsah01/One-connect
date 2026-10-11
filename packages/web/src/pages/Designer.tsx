// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Designer: describe an interface, and design it with your agent on a canvas. One start screen, one
// canvas with an ask bar, panels only when something is selected or a sheet is open.
import { useSearchParams } from 'react-router';
import type { ControlState } from '@acc/core';
import { DesignerHome } from '../components/designer/studio/DesignerHome';
import { DesignerStudio } from '../components/designer/studio/DesignerStudio';
import '../components/designer/studio/studio.css';
import { activeProject } from '../lib/desktop';

export function Designer({ state }: { state: ControlState }) {
  const [params, setParams] = useSearchParams();
  const id = params.get('document');
  const project = activeProject()?.project ?? 'browser';
  if (id) return <DesignerStudio key={`${project}:${id}`} state={state} id={id} onBack={() => setParams({})} />;
  return <DesignerHome key={project} state={state} onOpen={next => setParams({ document: next })} />;
}
