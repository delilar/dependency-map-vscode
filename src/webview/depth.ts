import type { Relation } from '../shared/model';

export interface NeighbourhoodOptions {
  nodeIds: Iterable<string>;
  relations: readonly Pick<Relation, 'sourceId' | 'targetId'>[];
  eligibleIds: ReadonlySet<string>;
  focusId?: string;
  depth: number;
  direction?: 'both' | 'incoming' | 'outgoing';
  forcedIds?: ReadonlySet<string>;
  nodeDepths?: Readonly<Record<string, number>>;
}

export function collectNeighbourhood(options: NeighbourhoodOptions): Set<string> {
  const known = new Set(options.nodeIds);
  const eligible = new Set(options.eligibleIds);
  const forced = [...options.forcedIds ?? []].filter(id => known.has(id));
  for (const id of forced) eligible.add(id);
  const adjacency = new Map<string, Set<string>>();
  const connect = (source: string, target: string) => {
    if (!known.has(source) || !known.has(target)) return;
    const neighbours = adjacency.get(source) ?? new Set<string>(); neighbours.add(target); adjacency.set(source, neighbours);
  };
  for (const relation of options.relations) {
    if (options.direction !== 'incoming') connect(relation.sourceId, relation.targetId);
    if (options.direction !== 'outgoing') connect(relation.targetId, relation.sourceId);
  }
  const budget = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 20 ? value : 0;
  const queue: { id: string; remaining: number }[] = forced.map(id => ({ id, remaining: 0 }));
  if (options.focusId && known.has(options.focusId)) queue.push({ id: options.focusId, remaining: budget(options.depth) });
  const best = new Map<string, number>();
  const included = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const { id } = queue[index];
    const local = eligible.has(id) && Object.hasOwn(options.nodeDepths ?? {}, id) ? budget(options.nodeDepths![id]) : 0;
    const remaining = Math.max(queue[index].remaining, local);
    if (remaining <= (best.get(id) ?? -1)) continue;
    best.set(id, remaining);
    if (eligible.has(id)) included.add(id);
    if (!remaining) continue;
    for (const target of adjacency.get(id) ?? []) if (eligible.has(target)) queue.push({ id: target, remaining: remaining - 1 });
  }
  return included;
}
