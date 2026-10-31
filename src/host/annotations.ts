import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileRef, RelationKind, WorkspaceRoot } from '../shared/model';

export interface AnnotationRoot { id: string; label: string; packageName?: string }
export interface ExternalRef { packageName: string; projectId: string }
export interface FileMark { file: FileRef; note?: string }
export interface RelationRef { source: FileRef; target: FileRef | ExternalRef; kind: RelationKind; specifier?: string }
export interface RelationMark extends RelationRef { note?: string }
export interface AnnotationGroup { id: string; name: string; color: string; files: FileMark[]; relations: RelationMark[] }
export interface AnnotationsDocument { version: 1; roots: AnnotationRoot[]; groups: AnnotationGroup[] }
export type AnnotationMutation =
  | { action: 'createGroup'; groupId?: string; name: string; color: string }
  | { action: 'createGroupAndMark'; groupId?: string; name: string; color: string; files?: FileRef[]; relations?: RelationRef[]; note?: string }
  | { action: 'updateGroup'; groupId: string; name?: string; color?: string }
  | { action: 'deleteGroup'; groupId: string }
  | { action: 'mark' | 'unmark' | 'note'; groupId: string; files?: FileRef[]; relations?: RelationRef[]; note?: string };

const kinds: RelationKind[] = ['import', 'reexport', 'resource', 'config', 'framework', 'environment'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never { throw new Error(`Invalid annotations: ${message}`); }
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('unsupported field');
}
function text(value: unknown, label: string, max = 200, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(label);
}
function identifier(value: unknown): asserts value is string {
  text(value, 'identifier');
  if (/[\s/\\:]/.test(value)) invalid('identifier');
}
function note(value: unknown): void { if (value !== undefined) text(value, 'note', 10000, true); }
function fileRef(value: unknown, rootIds: Set<string>): asserts value is FileRef {
  if (!object(value)) invalid('file reference');
  fields(value, ['rootId', 'path']);
  identifier(value.rootId);
  if (!rootIds.has(value.rootId)) invalid('unknown root reference');
  text(value.path, 'file path', 4096);
  if (/[\\:\u0000-\u001f]/.test(value.path) || value.path.startsWith('/') || value.path.split('/').some(part => !part || part === '.' || part === '..')) invalid('unsafe file path');
}
function targetRef(value: unknown, rootIds: Set<string>): void {
  if (!object(value)) invalid('relation target');
  if ('rootId' in value) return fileRef(value, rootIds);
  fields(value, ['packageName', 'projectId']);
  text(value.packageName, 'package name', 1000);
  text(value.projectId, 'project identifier', 4096);
}
export function fileMarkKey(file: FileRef): string { return JSON.stringify([file.rootId, file.path]); }
export function relationMarkKey(relation: RelationRef): string {
  const target = 'rootId' in relation.target
    ? ['file', relation.target.rootId, relation.target.path]
    : ['external', relation.target.packageName, relation.target.projectId];
  return JSON.stringify([fileMarkKey(relation.source), target, relation.kind, relation.specifier ?? '']);
}
function unique(keys: string[], label: string): void { if (new Set(keys).size !== keys.length) invalid(`duplicate ${label}`); }
function list(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 100000) invalid(label);
}

export function validateAnnotations(value: unknown): AnnotationsDocument {
  if (!object(value)) invalid('document');
  fields(value, ['version', 'roots', 'groups']);
  if (value.version !== 1) invalid('unsupported version');
  list(value.roots, 'roots');
  const rootIds = new Set<string>();
  for (const root of value.roots) {
    if (!object(root)) invalid('root');
    fields(root, ['id', 'label', 'packageName']);
    identifier(root.id); text(root.label, 'root label');
    if (root.packageName !== undefined) text(root.packageName, 'package name', 1000);
    if (rootIds.has(root.id)) invalid('duplicate root');
    rootIds.add(root.id);
  }
  list(value.groups, 'groups');
  const groupIds: string[] = [];
  for (const group of value.groups) {
    if (!object(group)) invalid('group');
    fields(group, ['id', 'name', 'color', 'files', 'relations']);
    identifier(group.id); text(group.name, 'group name');
    if (typeof group.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(group.color)) invalid('group color');
    groupIds.push(group.id);
    list(group.files, 'file marks');
    const fileKeys: string[] = [];
    for (const mark of group.files) {
      if (!object(mark)) invalid('file mark');
      fields(mark, ['file', 'note']);
      fileRef(mark.file, rootIds); note(mark.note);
      fileKeys.push(fileMarkKey(mark.file));
    }
    unique(fileKeys, 'file mark');
    list(group.relations, 'relation marks');
    const relationKeys: string[] = [];
    for (const mark of group.relations) {
      if (!object(mark)) invalid('relation mark');
      fields(mark, ['source', 'target', 'kind', 'specifier', 'note']);
      fileRef(mark.source, rootIds); targetRef(mark.target, rootIds);
      if (!kinds.includes(mark.kind as RelationKind)) invalid('relation kind');
      if (mark.specifier !== undefined) text(mark.specifier, 'specifier', 4096, true);
      note(mark.note);
      relationKeys.push(relationMarkKey(mark as unknown as RelationMark));
    }
    unique(relationKeys, 'relation mark');
  }
  unique(groupIds, 'group');
  return value as unknown as AnnotationsDocument;
}

export function createAnnotations(roots: WorkspaceRoot[]): AnnotationsDocument {
  return validateAnnotations({ version: 1, roots: roots.map(root => ({ id: root.id, label: root.name })), groups: [] });
}

function canonicalDocument(document: AnnotationsDocument): AnnotationsDocument {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return {
    version: 1,
    roots: [...document.roots].sort((a, b) => compare(a.id, b.id)).map(root => ({ id: root.id, label: root.label, ...(root.packageName === undefined ? {} : { packageName: root.packageName }) })),
    groups: [...document.groups].sort((a, b) => compare(a.id, b.id)).map(group => ({
      id: group.id, name: group.name, color: group.color,
      files: [...group.files].sort((a, b) => compare(fileMarkKey(a.file), fileMarkKey(b.file))).map(mark => ({ file: { rootId: mark.file.rootId, path: mark.file.path }, ...(mark.note === undefined ? {} : { note: mark.note }) })),
      relations: [...group.relations].sort((a, b) => compare(relationMarkKey(a), relationMarkKey(b))).map(mark => ({
        source: { rootId: mark.source.rootId, path: mark.source.path },
        target: 'rootId' in mark.target ? { rootId: mark.target.rootId, path: mark.target.path } : { packageName: mark.target.packageName, projectId: mark.target.projectId },
        kind: mark.kind, ...(mark.specifier === undefined ? {} : { specifier: mark.specifier }), ...(mark.note === undefined ? {} : { note: mark.note })
      }))
    }))
  };
}

export function stableSerialize(document: AnnotationsDocument): string {
  return JSON.stringify(canonicalDocument(validateAnnotations(document)), null, 2) + '\n';
}

export function applyAnnotationMutation(document: AnnotationsDocument, mutation: AnnotationMutation): AnnotationsDocument {
  const next = structuredClone(validateAnnotations(document));
  if (mutation.action === 'createGroup' || mutation.action === 'createGroupAndMark') {
    if (mutation.action === 'createGroupAndMark' && !(mutation.files?.length || mutation.relations?.length)) throw new Error('Select at least one file or relation before creating a marked group');
    const groupId = mutation.groupId ?? randomUUID();
    next.groups.push({ id: groupId, name: mutation.name, color: mutation.color, files: [], relations: [] });
    if (mutation.action === 'createGroupAndMark') return applyAnnotationMutation(next, { action: 'mark', groupId, files: mutation.files, relations: mutation.relations, note: mutation.note });
    return validateAnnotations(next);
  }
  const group = next.groups.find(item => item.id === mutation.groupId);
  if (!group) throw new Error('Annotation group no longer exists');
  if (mutation.action === 'deleteGroup') {
    next.groups = next.groups.filter(item => item.id !== mutation.groupId);
  } else if (mutation.action === 'updateGroup') {
    if (mutation.name !== undefined) group.name = mutation.name;
    if (mutation.color !== undefined) group.color = mutation.color;
  } else {
    const files = mutation.files ?? [];
    const relations = mutation.relations ?? [];
    for (const file of files) {
      const key = fileMarkKey(file);
      const existing = group.files.find(mark => fileMarkKey(mark.file) === key);
      if (mutation.action === 'unmark') group.files = group.files.filter(mark => fileMarkKey(mark.file) !== key);
      else if (existing) { if (mutation.note !== undefined) existing.note = mutation.note; }
      else if (mutation.action === 'mark') group.files.push({ file: structuredClone(file), ...(mutation.note === undefined ? {} : { note: mutation.note }) });
    }
    for (const relation of relations) {
      const key = relationMarkKey(relation);
      const existing = group.relations.find(mark => relationMarkKey(mark) === key);
      if (mutation.action === 'unmark') group.relations = group.relations.filter(mark => relationMarkKey(mark) !== key);
      else if (existing) { if (mutation.note !== undefined) existing.note = mutation.note; }
      else if (mutation.action === 'mark') group.relations.push({ ...structuredClone(relation), ...(mutation.note === undefined ? {} : { note: mutation.note }) });
    }
  }
  return validateAnnotations(next);
}

function fingerprint(content: string | undefined): string | undefined {
  return content === undefined ? undefined : createHash('sha256').update(content).digest('hex');
}
async function readExisting(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Annotations path must be a regular file');
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function parse(content: string): AnnotationsDocument {
  let value: unknown;
  try { value = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid annotations JSON; original file was not changed'); }
  return validateAnnotations(value);
}

export class AnnotationStore {
  private loaded = false;
  private baseline: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<AnnotationsDocument | undefined> {
    const content = await readExisting(this.filePath);
    const document = content === undefined ? undefined : parse(content);
    this.baseline = fingerprint(content);
    this.loaded = true;
    return document;
  }

  save(document: AnnotationsDocument): Promise<void> {
    const captured = structuredClone(validateAnnotations(document));
    const wasLoaded = this.loaded;
    const expected = this.baseline;
    const operation = this.queue.then(() => this.write(captured, wasLoaded, expected));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async write(document: AnnotationsDocument, wasLoaded: boolean, expected: string | undefined): Promise<void> {
    if (!wasLoaded) { await this.load(); expected = this.baseline; }
    const current = await readExisting(this.filePath);
    if (fingerprint(current) !== expected) throw new Error('Annotations changed externally. Reload before saving.');
    const serialized = stableSerialize(document);
    if (current !== undefined && stableSerialize(parse(current)) === serialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      // shortcut: no filesystem CAS, retry after any detected concurrent edit.
      if (fingerprint(await readExisting(this.filePath)) !== expected) throw new Error('Annotations changed externally. Reload before saving.');
      await fs.rename(temporary, this.filePath);
      this.baseline = fingerprint(serialized);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
