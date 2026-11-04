import type { GraphSnapshot, Relation } from '../shared/model';
import type { ExportEntry, ExportResolution, SymbolNamespace } from '../shared/query-model';

export interface ExportTables {
  exports: Map<string, ExportEntry[]>;
  relations: Map<string, Relation>;
  graph: GraphSnapshot;
  nodes: Map<string, GraphSnapshot['nodes'][number]>;
  coverage: Map<string, NonNullable<GraphSnapshot['coverage']>[number]>;
  cache: Map<string, ExportResolution>;
}

export function exportTables(graph: GraphSnapshot): ExportTables {
  const exports = new Map<string, ExportEntry[]>();
  for (const entry of graph.exports ?? []) { const rows = exports.get(entry.fileId) ?? []; rows.push(entry); exports.set(entry.fileId, rows); }
  return { exports, relations: new Map(graph.relations.map(edge => [edge.id, edge])), graph,
    nodes: new Map(graph.nodes.map(node => [node.id, node])), coverage: new Map((graph.coverage ?? []).map(row => [row.fileId, row])), cache: new Map() };
}

const compatible = (entry: SymbolNamespace, requested: SymbolNamespace) => entry === 'both' || requested === 'both' || entry === requested;
const candidateKey = (candidate: ExportResolution['candidates'][number]) => JSON.stringify([candidate.fileId, candidate.name, candidate.namespace, candidate.range]);
export interface ExportResolutionStep { fileId?: string; relationId?: string }

/** Resolve only explicit ESM forwarding. Never infer an export from the imports used by its implementation. */
function* resolutionSteps(tables: ExportTables, fileId: string, name: string, namespace: SymbolNamespace): Generator<ExportResolutionStep, ExportResolution> {
  const cacheKey = JSON.stringify([fileId, name, namespace]);
  const cached = tables.cache.get(cacheKey);
  if (cached) {
    yield { fileId };
    for (const candidate of cached.candidates) {
      for (const relationId of candidate.relationIds) {
        const edge = tables.relations.get(relationId);
        if (edge) { yield { fileId: edge.sourceId }; yield { fileId: edge.targetId }; yield { relationId }; }
      }
      yield { fileId: candidate.fileId };
    }
    return cached;
  }
  let examined = 0;
  type Part = { candidates: ExportResolution['candidates']; reasons: string[]; incomplete: boolean; unsupported: boolean };
  const memo = new Map<string, Part>();
  function* walk(file: string, exported: string, requested: SymbolNamespace, seen: Set<string>, depth: number): Generator<ExportResolutionStep, Part> {
    yield { fileId: file };
    const key = JSON.stringify([file, exported, requested]);
    if (seen.has(key)) return { candidates: [], reasons: ['exportCycle'], incomplete: false, unsupported: false };
    const cached = memo.get(key);
    if (cached) return cached;
    if (++examined > 10000 || depth > 100) return { candidates: [], reasons: ['resolutionLimit'], incomplete: true, unsupported: false };
    const node = tables.nodes.get(file);
    if (!node?.file) return { candidates: [], reasons: ['missingModule'], incomplete: true, unsupported: false };
    const coverage = tables.coverage.get(file);
    const failures = coverage?.reasonCodes.filter(reason => ['readFailed', 'textLimit', 'unsupportedCommonJs', 'scriptParseDiagnostic', ...(coverage.symbols === undefined ? ['parseDiagnostic'] : [])].includes(reason)) ?? [];
    if (failures.length) return { candidates: [], reasons: failures, incomplete: true, unsupported: failures.includes('unsupportedCommonJs') };
    if (coverage?.symbols === 'unavailable' || coverage?.symbols === undefined && !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(node.format)) return { candidates: [], reasons: ['unsupportedFormat'], incomplete: true, unsupported: true };
    const entries = tables.exports.get(file) ?? [];
    const explicit = entries.filter(entry => entry.name === exported && entry.kind !== 'star' && compatible(entry.namespace, requested));
    const active = explicit.length ? explicit : exported === 'default' ? [] : entries.filter(entry => entry.kind === 'star' && compatible(entry.namespace, requested));
    const result: Part = { candidates: [], reasons: coverage?.symbols === 'limited' ? ['partialExportResolution'] : [], incomplete: coverage?.symbols === 'limited', unsupported: false };
    const nextSeen = new Set(seen).add(key);
    for (const entry of active) {
      yield {};
      if (entry.kind === 'namespace') { result.incomplete = true; result.unsupported = true; result.reasons.push('namespaceExport'); continue; }
      if (entry.kind === 'direct') {
        result.candidates.push({ fileId: file, name: entry.name, namespace: entry.namespace, range: entry.range, relationIds: [] }); continue;
      }
      const edge = entry.forwarded?.relationId ? tables.relations.get(entry.forwarded.relationId) : undefined;
      if (!edge || !['import', 'reexport'].includes(edge.kind) || edge.certainty !== 'confirmed') { result.incomplete = true; result.reasons.push('missingModule'); continue; }
      const nextName = entry.kind === 'star' ? exported : entry.forwarded!.imported;
      if (nextName === '*') { result.incomplete = true; result.unsupported = true; result.reasons.push('namespaceExport'); continue; }
      yield { relationId: edge.id };
      const part = yield* walk(edge.targetId, nextName, entry.namespace === 'type' ? 'type' : requested, nextSeen, depth + 1);
      result.reasons.push(...part.reasons); result.incomplete ||= part.incomplete; result.unsupported ||= part.unsupported;
      result.candidates.push(...part.candidates.map(candidate => ({ ...candidate, relationIds: [edge.id, ...candidate.relationIds] })));
    }
    const unique = new Map<string, ExportResolution['candidates'][number]>();
    for (const candidate of result.candidates) {
      const key = candidateKey(candidate), previous = unique.get(key);
      unique.set(key, previous ? { ...previous, relationIds: [...new Set([...previous.relationIds, ...candidate.relationIds])] } : candidate);
    }
    result.candidates = [...unique.values()];
    if (!result.reasons.includes('exportCycle') && !result.reasons.includes('resolutionLimit')) memo.set(key, result);
    return result;
  }
  const result = yield* walk(fileId, name, namespace, new Set(), 0);
  const status = result.candidates.length > 1 ? 'ambiguous' : result.incomplete ? result.unsupported && !result.candidates.length ? 'unsupported' : 'unresolved' : result.candidates.length === 1 ? 'resolved' : 'unresolved';
  const reasonCodes = [...new Set(result.reasons)];
  if (!result.candidates.length && !reasonCodes.length) reasonCodes.push('exportMissing');
  if (result.incomplete && result.candidates.length) reasonCodes.push('partialExportResolution');
  const resolution = { status, reasonCodes, candidates: result.candidates } satisfies ExportResolution;
  if (status === 'resolved' || status === 'ambiguous') {
    if (tables.cache.size >= 2000) tables.cache.delete(tables.cache.keys().next().value!);
    tables.cache.set(cacheKey, resolution);
  }
  return resolution;
}

export function resolveExport(tables: ExportTables, fileId: string, name: string, namespace: SymbolNamespace): ExportResolution {
  const steps = resolutionSteps(tables, fileId, name, namespace);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** The query driver shares its node/edge/deadline/cancellation budget with export provenance work. */
export async function resolveExportAsync(tables: ExportTables, fileId: string, name: string, namespace: SymbolNamespace, proceed: (step: ExportResolutionStep) => Promise<boolean>): Promise<ExportResolution> {
  const steps = resolutionSteps(tables, fileId, name, namespace);
  let next = steps.next();
  while (!next.done) {
    if (!await proceed(next.value)) {
      const incomplete = { status: 'unresolved' as const, reasonCodes: ['resolutionLimited'], candidates: [] };
      steps.return(incomplete);
      return incomplete;
    }
    next = steps.next();
  }
  return next.value;
}
