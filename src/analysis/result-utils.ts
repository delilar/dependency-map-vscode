import type { SourceRange } from '../shared/model';
import type { JsResult } from './javascript';

export function emptySourceResult(): JsResult {
  return { references: [], diagnostics: [], childReferences: [], providers: [], consumers: [], exports: [] };
}

export function sourceRange(text: string, start: number, end: number): SourceRange {
  const position = (offset: number) => {
    const prefix = text.slice(0, Math.max(0, Math.min(offset, text.length)));
    const line = (prefix.match(/\n/g) ?? []).length;
    return { line, character: prefix.length - prefix.lastIndexOf('\n') - 1 };
  };
  return { start: position(start), end: position(end) };
}

export function mergeSourceRegion(target: JsResult, part: Partial<JsResult> & Pick<JsResult, 'references' | 'diagnostics'>, text: string, offset: number, options: { exports?: boolean } = {}): void {
  const regionText = text.slice(offset);
  const offsetOf = (position: SourceRange['start']) => {
    let start = 0;
    for (let line = 0; line < position.line; line++) {
      const next = regionText.indexOf('\n', start);
      if (next < 0) return regionText.length;
      start = next + 1;
    }
    return start + position.character;
  };
  const range = (value: SourceRange | undefined) => value && sourceRange(text, offset + offsetOf(value.start), offset + offsetOf(value.end));
  const evidence = <T extends { range?: SourceRange }>(value: T): T => ({ ...value, range: range(value.range) });
  target.references.push(...part.references.map(reference => ({ ...reference, evidence: evidence(reference.evidence), occurrences: reference.occurrences?.map(item => ({ ...item, range: range(item.range)! })) })));
  target.diagnostics.push(...part.diagnostics);
  if (options.exports !== false) target.exports.push(...(part.exports ?? []).map(item => ({ ...item, range: range(item.range)! })));
  target.childReferences.push(...(part.childReferences ?? []).map(item => ({ ...item, evidence: evidence(item.evidence) })));
  target.providers.push(...(part.providers ?? []).map(item => ({ ...item, evidence: evidence(item.evidence) })));
  target.consumers.push(...(part.consumers ?? []).map(item => ({ ...item, evidence: evidence(item.evidence) })));
  if (part.childName) target.childName = part.childName;
  target.unsupportedExports ||= part.unsupportedExports;
  if (part.layout !== undefined) target.layout = part.layout;
  target.layoutDynamic ||= part.layoutDynamic;
  if (part.globs?.length) (target.globs ??= []).push(...part.globs.map(item => ({ ...item, evidence: evidence(item.evidence) })));
  if (part.implicitNames?.length) (target.implicitNames ??= []).push(...part.implicitNames.map(item => ({ ...item, evidence: evidence(item.evidence) })));
  if (part.capabilityReasons?.length) (target.capabilityReasons ??= []).push(...part.capabilityReasons);
  if (part.graphql) {
    target.graphql ??= { definitions: [], spreads: [] };
    target.graphql.definitions.push(...part.graphql.definitions.map(item => ({ ...item, range: range(item.range)! })));
    target.graphql.spreads.push(...part.graphql.spreads.map(item => ({ ...item, range: range(item.range)! })));
  }
}
