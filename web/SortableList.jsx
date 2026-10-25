import React, { useState } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const pointFrom = (event, delta) => event && 'clientX' in event ? { x: event.clientX + delta.x, y: event.clientY + delta.y } : null;

// isOutside/onOutsideMove/onDropOutside let a pointer drag leave the list for another drop target, such as the queue.
export function SortableList({ items, getLabel, onStart, onEnd, onCancel, children, isOutside, onOutsideMove, onDropOutside, outsideHint = '' }) {
  const [activeId, setActiveId] = useState(null);
  const [outside, setOutside] = useState(false);
  const sensors = useSensors(
    // Whole rows are draggable: a short move starts a drag so clicks still play, and touch waits for a hold so lists still scroll.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  return <DndContext sensors={sensors} collisionDetection={args => args.pointerCoordinates && isOutside?.(args.pointerCoordinates) ? [] : closestCenter(args)}
    accessibility={{
      announcements: {
        onDragStart: ({ active }) => `${getLabel(active.id)} picked up.`,
        onDragOver: ({ active, over }) => over ? `${getLabel(active.id)} at position ${items.indexOf(over.id) + 1} of ${items.length}.` : `${getLabel(active.id)} is outside the list.`,
        onDragEnd: ({ active, over }) => over ? `${getLabel(active.id)} dropped at position ${items.indexOf(over.id) + 1}.` : 'Reorder cancelled.',
        onDragCancel: () => 'Reorder cancelled.',
      },
    }}
    onDragStart={({ active }) => { setActiveId(active.id); onStart(items.indexOf(active.id)); }}
    onDragMove={({ active, activatorEvent, delta }) => {
      const point = pointFrom(activatorEvent, delta);
      if (!point || !isOutside) return;
      setOutside(isOutside(point));
      onOutsideMove?.(point, active.id);
    }}
    onDragEnd={async ({ active, over, activatorEvent, delta }) => {
      setActiveId(null);
      setOutside(false);
      const target = over ? items.indexOf(over.id) : -1;
      const point = pointFrom(activatorEvent, delta);
      if (target >= 0) await onEnd(target);
      else { onCancel(); if (point) onDropOutside?.(point, active.id); }
    }}
    onDragCancel={() => { setActiveId(null); setOutside(false); onCancel(); }}>
    <SortableContext items={items} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    <DragOverlay dropAnimation={null}>{activeId !== null && <div className="drag-preview"><span>{getLabel(activeId)}</span><small>{outside && outsideHint ? outsideHint : 'Move to reorder'}</small></div>}</DragOverlay>
  </DndContext>;
}

export function SortableItem({ id, disabled, children }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return children({ ref: setNodeRef, ...listeners, style: { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .3 : undefined } });
}
