import React, { useRef, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const pointFrom = (event, delta) => event && 'clientX' in event ? { x: event.clientX + delta.x, y: event.clientY + delta.y } : null;

// isOutside/onOutsideMove/onDropOutside let a pointer drag leave the list for another drop target, such as the queue.
export function SortableList({ items, getLabel, onStart, onEnd, onCancel, children, isOutside, onOutsideMove, onDropOutside, outsideHint = '' }) {
  const activator = useRef(null);
  const [activeId, setActiveId] = useState(null);
  const [outside, setOutside] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return <DndContext sensors={sensors} collisionDetection={args => args.pointerCoordinates && isOutside?.(args.pointerCoordinates) ? [] : closestCenter(args)}
    accessibility={{
      screenReaderInstructions: { draggable: 'Press Space to pick up a song. Use the arrow keys to move it. Press Space to drop or Escape to cancel.' },
      announcements: {
        onDragStart: ({ active }) => `${getLabel(active.id)} picked up.`,
        onDragOver: ({ active, over }) => over ? `${getLabel(active.id)} at position ${items.indexOf(over.id) + 1} of ${items.length}.` : `${getLabel(active.id)} is outside the list.`,
        onDragEnd: ({ active, over }) => over ? `${getLabel(active.id)} dropped at position ${items.indexOf(over.id) + 1}.` : 'Reorder cancelled.',
        onDragCancel: () => 'Reorder cancelled.',
      },
    }}
    onDragStart={({ active, activatorEvent }) => { activator.current = activatorEvent instanceof KeyboardEvent ? activatorEvent.target : null; setActiveId(active.id); onStart(items.indexOf(active.id)); }}
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
      if (activator.current?.isConnected) activator.current.focus({ preventScroll: true });
      activator.current = null;
    }}
    onDragCancel={() => { setActiveId(null); setOutside(false); onCancel(); }}>
    <SortableContext items={items} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    <DragOverlay>{activeId !== null && <div className="drag-preview"><span>{getLabel(activeId)}</span><small>{outside && outsideHint ? outsideHint : 'Move to reorder'}</small></div>}</DragOverlay>
  </DndContext>;
}

export function SortableItem({ id, disabled, children }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return children({
    rowProps: { ref: setNodeRef, style: { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .3 : undefined } },
    handleProps: { ref: setActivatorNodeRef, ...attributes, ...listeners },
  });
}
