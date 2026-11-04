import type { GraphSnapshot, Relation } from '../shared/model';
import type { BindingOccurrence, ExportEntry } from '../shared/query-model';
import type { JsResult } from './javascript';

export function symbolContributions(relations: GraphSnapshot['relations'], sources: Iterable<[string, { result: JsResult }]>, semanticOccurrences: BindingOccurrence[] = []): { exports: ExportEntry[]; bindingOccurrences: BindingOccurrence[] } {
  const exports: ExportEntry[] = [], bindingOccurrences = [...semanticOccurrences];
  const sourceRelations = new Map<string, Map<string, Relation[]>>();
  for (const edge of relations) {
    const map = sourceRelations.get(edge.sourceId) ?? new Map<string, Relation[]>();
    const key = JSON.stringify([edge.kind, edge.specifier]);
    map.set(key, [...(map.get(key) ?? []), edge]); sourceRelations.set(edge.sourceId, map);
  }
  for (const [sourceId, entry] of sources) {
    const relationFor = (kind: string, specifier: string, imported?: string) => {
      const edges = sourceRelations.get(sourceId)?.get(JSON.stringify([kind, specifier])) ?? [];
      const candidates = imported && edges.length > 1 ? edges.filter(edge => edge.bindings.some(binding => binding.imported === imported)) : edges;
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    for (const exported of entry.result.exports) {
      const edge = exported.forwarded && relationFor(exported.forwarded.referenceKind, exported.forwarded.module, exported.forwarded.imported);
      const imported = exported.forwarded && (edge?.bindings.find(binding => binding.imported === exported.forwarded!.imported)?.resolvedImported ?? exported.forwarded.imported);
      exports.push({ fileId: sourceId, name: exported.name, namespace: exported.namespace, kind: exported.kind, range: exported.range,
        ...(exported.forwarded ? { forwarded: { relationId: edge?.id, imported: imported! } } : {}) });
    }
    for (const reference of entry.result.references) {
      if (!reference.specifier || !reference.occurrences || !['import', 'reexport'].includes(reference.kind)) continue;
      for (const occurrence of reference.occurrences) {
        const edge = relationFor(reference.kind, reference.specifier, occurrence.imported);
        if (edge) bindingOccurrences.push({ relationId: edge.id, ...occurrence, imported: edge.bindings.find(binding => binding.imported === occurrence.imported)?.resolvedImported ?? occurrence.imported });
      }
    }
  }
  const order = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));
  exports.sort(order); bindingOccurrences.sort(order);
  return { exports, bindingOccurrences };
}
