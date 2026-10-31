import type { FileRef, GraphNode, GraphSnapshot } from '../shared/model';
import type { AnnotationGroup, RelationMark } from '../host/annotations';
import { normalizeHexColor } from './group-draft';
export type { AnnotationGroup, RelationMark as AnnotationRelation } from '../host/annotations';

export interface GraphAppearance {
  nodeFills: Map<string, string>;
  nodeBorders: Map<string, string>;
  edgeColors: Map<string, string>;
  folderColors: Map<string, string>;
}

export const FORMAT_COLORS: Readonly<Record<string, string>> = {
  '.ts': '#3178c6', '.tsx': '#61dafb', '.js': '#e6c84f', '.jsx': '#e89d3c',
  '.mjs': '#c0ab32', '.cjs': '#a78b32', '.mts': '#4f91b8', '.cts': '#5f73ae',
  '.css': '#a86bd4', '.scss': '#cd6799', '.sass': '#b94f87', '.less': '#5776ad', '.styl': '#94a84b',
  '.html': '#e8744b', '.htm': '#d98561', '.json': '#d69a35', '.jsonc': '#bd9a4e',
  '.yaml': '#d17b91', '.yml': '#b66581', '.toml': '#a87159', '.xml': '#c38361', '.csv': '#74a974',
  '.env': '#57ad79', '.svg': '#b179dc', '.png': '#8a91df', '.jpg': '#ab8cce', '.jpeg': '#b995d8',
  '.webp': '#809fcd', '.gif': '#b389b4', '.avif': '#8186bc', '.ico': '#ad9ecb',
  '.woff': '#a2a87d', '.woff2': '#8b9c71', '.ttf': '#b1a26e', '.otf': '#b7ac83',
  '.md': '#80a5a8', '.mdx': '#69b4b1', '.graphql': '#d26aaf', '.gql': '#b56898',
  '.mp3': '#ca8662', '.wav': '#c99872', '.ogg': '#bca16f', '.mp4': '#8777bf', '.webm': '#7276ac',
  '.wasm': '#8277df', '.glsl': '#7baf9e', '.vert': '#68a58d', '.frag': '#57947b', '.pdf': '#cf746c'
};
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}
const folderPalette = ['#4d8cb5', '#8f79b6', '#b58167', '#659d89', '#a99a5f', '#aa7598', '#7396a3', '#8b9c68'];
export function folderTint(id: string): string { return folderPalette[stableHash(id) % folderPalette.length]; }
export function formatFill(node: Pick<GraphNode, 'kind' | 'format'>): string {
  if (node.kind === 'external') return '#7d8590';
  const format = node.format.toLowerCase();
  if (format === '.env' || format.startsWith('.env.')) return FORMAT_COLORS['.env'];
  return FORMAT_COLORS[format] ?? folderPalette[stableHash(format) % folderPalette.length];
}
const fileKey = (file: FileRef) => JSON.stringify([file.rootId, file.path]);
function edgeKey(source: FileRef, target: RelationMark['target'], kind: string, specifier = ''): string {
  return JSON.stringify([fileKey(source), 'rootId' in target ? ['file', target.rootId, target.path] : ['external', target.projectId, target.packageName], kind, specifier]);
}
function explicitMarks(graph: Pick<GraphSnapshot, 'nodes' | 'relations'>, group: AnnotationGroup | undefined): { fileIds: Set<string>; relationIds: Set<string> } {
  const fileIds = new Set<string>(), relationIds = new Set<string>();
  if (!group) return { fileIds, relationIds };
  const markedFiles = new Set(group.files.map(mark => fileKey(mark.file)));
  const markedEdges = new Set(group.relations.map(mark => edgeKey(mark.source, mark.target, mark.kind, mark.specifier)));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) if (node.file && markedFiles.has(fileKey(node.file))) fileIds.add(node.id);
  for (const edge of graph.relations) {
    const source = nodes.get(edge.sourceId), target = nodes.get(edge.targetId);
    if (!source?.file || !target) continue;
    const endpoint = target.file ?? (target.packageName ? { packageName: target.packageName, projectId: target.projectId } : undefined);
    if (endpoint && markedEdges.has(edgeKey(source.file, endpoint, edge.kind, edge.specifier))) relationIds.add(edge.id);
  }
  return { fileIds, relationIds };
}
export function groupFilterIds(graph: Pick<GraphSnapshot, 'nodes' | 'relations'>, group: AnnotationGroup | undefined): Set<string> {
  const marks = explicitMarks(graph, group);
  const result = new Set([...marks.fileIds, ...marks.relationIds]);
  for (const edge of graph.relations) if (marks.relationIds.has(edge.id)) { result.add(edge.sourceId); result.add(edge.targetId); }
  return result;
}
export function createGraphAppearance(graph: Pick<GraphSnapshot, 'nodes' | 'relations'>, group: AnnotationGroup | undefined, folders: readonly { id: string }[] = [], showGroupColors = true): GraphAppearance {
  const appearance: GraphAppearance = {
    nodeFills: new Map(graph.nodes.map(node => [node.id, formatFill(node)])),
    nodeBorders: new Map(), edgeColors: new Map(), folderColors: new Map(folders.map(folder => [folder.id, folderTint(folder.id)]))
  };
  const color = group ? normalizeHexColor(group.color) : undefined;
  if (!showGroupColors || !group || !color) return appearance;
  const marks = explicitMarks(graph, group);
  for (const id of marks.fileIds) appearance.nodeBorders.set(id, color);
  for (const id of marks.relationIds) appearance.edgeColors.set(id, color);
  return appearance;
}
