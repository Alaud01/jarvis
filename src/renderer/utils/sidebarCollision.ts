import { closestCenter, pointerWithin } from '@dnd-kit/core';
import type { CollisionDetection } from '@dnd-kit/core';

// A nearby row is not a drop target unless the pointer actually hits it.
// Prefer rows over their enclosing folder/root zone when both are hit.
export const sidebarCollision: CollisionDetection = (args) => {
  const hits = new Set(pointerWithin(args).map(hit => hit.id));
  const containers = args.droppableContainers.filter(container => hits.has(container.id));
  const rows = containers.filter(container => container.data.current?.type === 'conversation');
  return closestCenter({
    ...args,
    droppableContainers: rows.length > 0 ? rows : containers,
  });
};
