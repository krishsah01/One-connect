// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Now/Next queues per agent. Drag to reorder within a lane, or onto another agent to reassign.
import { useState } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ControlState } from '@acc/core';
import { post } from '../lib/api';
import { AGENT_TONE } from '../lib/format';
import { ErrorLine, Light, useAction } from './common';

function QItem({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} className="qitem" style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }} {...attributes} {...listeners}>
      {label}
    </div>
  );
}

function Lane({ agentId, children }: { agentId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${agentId}` });
  return (
    <div ref={setNodeRef} className={`lane${isOver ? ' over' : ''}`}>
      {children}
    </div>
  );
}

export function QueueEditor({ state }: { state: ControlState }) {
  const { error, run } = useAction();
  const [optimistic, setOptimistic] = useState<Record<string, string[]> | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const agents = Object.values(state.agents);
  const queues: Record<string, string[]> = optimistic ?? Object.fromEntries(agents.map((a) => [a.id, a.queue.next]));
  const owner = (assignmentId: string) => Object.keys(queues).find((k) => queues[k].includes(assignmentId));
  const label = (assignmentId: string) => {
    const w = state.workItems[state.assignments[assignmentId]?.workItemId];
    return `${w?.key ?? '…'} ${w?.title ?? ''}`;
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    const from = owner(id);
    const to = over.startsWith('lane:') ? over.slice(5) : owner(over);
    if (!from || !to) return;
    const next = { ...queues, [from]: [...queues[from]] };
    if (from === to) {
      const oldI = next[from].indexOf(id);
      const newI = over.startsWith('lane:') ? next[from].length - 1 : next[from].indexOf(over);
      next[from] = arrayMove(next[from], oldI, newI);
    } else {
      next[from] = next[from].filter((x) => x !== id);
      const dest = [...(queues[to] ?? [])];
      const at = over.startsWith('lane:') ? dest.length : dest.indexOf(over);
      dest.splice(at < 0 ? dest.length : at, 0, id);
      next[to] = dest;
    }
    setOptimistic(next);
    void run(async () => {
      if (from !== to) await post(`/api/agents/${from}/queue`, { next: next[from] });
      await post(`/api/agents/${to}/queue`, { next: next[to] });
    }).finally(() => setOptimistic(null));
  };

  return (
    <div className="col" id="queues">
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="lanes">
          {agents.map((a) => {
            const nowA = a.queue.now ? state.assignments[a.queue.now] : null;
            return (
              <Lane key={a.id} agentId={a.id}>
                <div className="row small">
                  <Light tone={AGENT_TONE[a.status]} />
                  <b>{a.config.name}</b>
                  <span className="faint">{a.status}</span>
                </div>
                <div className="qitem now" title="Now (running or current)">
                  <span className="faint">Now · </span>
                  {nowA ? label(nowA.id) : <span className="faint">free</span>}
                </div>
                <SortableContext items={queues[a.id] ?? []} strategy={verticalListSortingStrategy}>
                  {(queues[a.id] ?? []).map((id) => (
                    <QItem key={id} id={id} label={label(id)} />
                  ))}
                </SortableContext>
                {(queues[a.id] ?? []).length === 0 && <div className="small faint" style={{ marginTop: 6 }}>Next is empty: drop work here</div>}
              </Lane>
            );
          })}
        </div>
      </DndContext>
      <ErrorLine error={error} />
    </div>
  );
}
