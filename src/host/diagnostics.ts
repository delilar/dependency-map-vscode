import type { GraphSnapshot } from '../shared/model';
import type { ActiveQuery, BuildIdentity, GitStatusSnapshot, IndexState, RuntimeState } from '../shared/query-model';

export interface DiagnosticInput { runtime: RuntimeState; index: IndexState; graph: GraphSnapshot; git?: GitStatusSnapshot; active?: ActiveQuery }
const knownReasons = new Set([
  'indexChanged', 'scopeChanged', 'indexEmpty', 'indexStale', 'indexFailed', 'indexCancelled', 'staleIndex', 'staleQuery', 'missingSeed',
  'workerStopped', 'workerMissing', 'workerFailed', 'workerUnavailable', 'workerMismatch', 'webviewMismatch', 'protocolMismatch', 'buildMismatch', 'legacyWebview', 'installedVersionMismatch',
  'webviewNotReady', 'webviewBuildMismatch', 'workerBuildMismatch', 'installedRunningVersionMismatch', 'workspaceChanged', 'indexBuilding', 'analysisFailed', 'analysisCancelled', 'sharedAnnotationsUnavailable',
  'cancelled', 'failed', 'queryCancelled', 'queryFailed', 'nodeLimit', 'relationLimit', 'deadline', 'depthLimit', 'sourceUnavailable',
  'unresolvedReferences', 'unsupportedFormat', 'nodeOnly', 'readFailed', 'fileTooLarge', 'partialStarBranch', 'missingModule', 'unsupportedCommonJs', 'cycle', 'namespace',
  'parseDiagnostic', 'unresolvedReference', 'unsupportedInternalReferences', 'formatUnavailable', 'configurationDiagnostic', 'coverageUnavailable', 'resourceNode', 'inventoryReadFailed',
  'deadlineLimit', 'missingTarget', 'exportMissing', 'partialExportResolution', 'resolutionLimited', 'provenancePathMissing', 'unsupportedBinding', 'namespaceImport', 'ambiguousConsumerExport', 'partialConsumerExport', 'ambiguousExport', 'queryQueueLimit', 'indexVersionMismatch',
  'cachedProviderState', 'providerMissing', 'providerInactive', 'providerDisabled', 'providerUninitialized', 'providerReadFailed', 'repositoryReadFailed', 'rowLimit', 'untrackedNotInPhysicalInventory',
  'missingReferences', 'missingRelations', 'groupChanged', 'groupMissing', 'followPaused',
  'queryScopeChanged', 'parserFailed', 'scriptParseDiagnostic', 'frameworkLimited', 'partialSymbolCoverage', 'frameworkScopeBoundary',
]);
const knownCapabilities = new Set(['queries', 'branches', 'git', 'taskContexts', 'diagnostics', 'webFormats', 'scopes']);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(1e9, Math.floor(value)) : 0;
const elapsed = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(3600000, Math.round(value * 100) / 100) : 0;
const reasonSummary = (values: string[]) => ({ codes: [...new Set(values.filter(value => knownReasons.has(value)))].sort(), otherCount: values.filter(value => !knownReasons.has(value)).length });
const pick = <T extends string>(value: T, allowed: readonly string[]): T | 'unknown' => allowed.includes(value) ? value : 'unknown';
const version = (value: string) => /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z0-9.-]{1,40})?$/i.test(value) ? value : 'unknown';
function build(value?: BuildIdentity) {
  if (!value) return null;
  return {
    extensionVersion: version(value.extensionVersion), buildId: /^(?:[a-f0-9]{8,64}|development)$/i.test(value.buildId) ? value.buildId : 'unknown',
    protocolVersion: count(value.protocolVersion), capabilities: [...new Set(value.capabilities.filter(item => knownCapabilities.has(item)))].sort(),
  };
}

/** Construct a fresh allowlisted DTO; never copy diagnostic messages, references, or provider metadata. */
export function createDiagnostics(input: DiagnosticInput) {
  const { runtime, index, graph, git, active } = input;
  return {
    schemaVersion: 1,
    runtime: {
      host: build(runtime.host), worker: build(runtime.worker), webview: build(runtime.webview), installedVersion: version(runtime.installedVersion),
      compatible: runtime.compatible === true, reasons: reasonSummary(runtime.reasonCodes),
    },
    index: {
      state: pick(index.state, ['empty', 'building', 'ready', 'stale', 'failed', 'cancelled']),
      revision: count(index.version.revision), scopeRevision: count(index.version.scopeRevision), reasons: reasonSummary(index.reasonCodes),
    },
    graph: {
      files: count(graph.stats.files), relations: count(graph.stats.relations), unresolved: count(graph.unresolved.length), diagnostics: count(graph.diagnostics.length), analysisElapsedMs: elapsed(graph.stats.elapsedMs),
      coverage: {
        parsed: count(graph.coverage?.filter(row => row.status === 'parsed').length), nodeOnly: count(graph.coverage?.filter(row => row.status === 'nodeOnly').length),
        skipped: count(graph.coverage?.filter(row => row.status === 'skipped').length), failed: count(graph.coverage?.filter(row => row.status === 'failed').length),
        reasons: reasonSummary([...(graph.coverageReasons ?? []), ...(graph.coverage?.flatMap(row => row.reasonCodes) ?? [])]),
      },
    },
    git: git ? {
      state: pick(git.providerState, ['available', 'inactive', 'disabled', 'unavailable', 'failed']), revision: count(git.gitRevision),
      repositories: count(git.repositories.length), failedRepositories: count(git.repositories.filter(repo => repo.state === 'failed').length),
      rows: count(git.rows.length), omitted: count(git.omissions), staged: count(git.rows.filter(row => row.staged).length),
      unstaged: count(git.rows.filter(row => row.unstaged).length), dirtyBuffers: count(git.rows.filter(row => row.dirty).length), reasons: reasonSummary(git.reasonCodes),
    } : null,
    query: active ? {
      kind: pick(active.query.kind, ['impact', 'neighbourhood', 'path', 'symbol']), state: pick(active.state, ['running', 'ready', 'cancelled', 'failed', 'stale']),
      result: active.result ? {
        operation: pick(active.result.operation, ['success', 'cancelled', 'failed']), coverage: pick(active.result.coverage, ['complete', 'partial', 'unknown']),
        freshness: pick(active.result.freshness, ['current', 'stale']), visitedNodes: count(active.result.visitedNodes), examinedRelations: count(active.result.examinedRelations),
        foundNodes: count(active.result.nodeIds.length), foundRelations: count(active.result.relationIds.length), reasons: reasonSummary(active.result.reasonCodes),
      } : null,
    } : null,
  };
}

export function formatDiagnostics(input: DiagnosticInput): string { return JSON.stringify(createDiagnostics(input), null, 2); }
