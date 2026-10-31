import path from 'node:path';
import postcss from 'postcss';
import scss from 'postcss-scss';
import valueParser from 'postcss-value-parser';
import { parse } from 'parse5';
import type { Evidence, SourceRange } from '../shared/model';
import type { Reference } from './javascript';
import { extractAdditionalStyles } from './style-formats';

export { extractEnvironmentKeys as extractEnvKeys } from '../shared/environment';
export function extractResources(file: string, text: string): { references: Reference[]; diagnostics: string[] } {
  if (['.sass', '.less', '.styl'].includes(path.extname(file).toLowerCase())) return extractAdditionalStyles(file, text);
  const references: Reference[] = [];
  const diagnostics: string[] = [];
  const local = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
  const add = (value: string, evidence: Evidence) => {
    if (local(value)) references.push({ specifier: value, kind: 'resource', bindings: [], evidence });
  };
  const extension = path.extname(file).toLowerCase();
  if (['.css', '.scss'].includes(extension)) {
    try {
      const root = extension === '.scss' ? scss.parse(text, { from: file, map: false }) : postcss.parse(text, { from: file, map: false });
      const ev = (node: postcss.Node, rule: string): Evidence => {
        const start = node.source?.start; const end = node.source?.end;
        const range: SourceRange | undefined = start && end ? { start: { line: start.line - 1, character: start.column - 1 }, end: { line: end.line - 1, character: end.column } } : undefined;
        return { rule, range };
      };
      root.walkAtRules(rule => {
        if (!['import', 'use', 'forward'].includes(rule.name.toLowerCase())) return;
        const tokens = valueParser(rule.params).nodes;
        for (const token of tokens) {
          if (token.type === 'string') add(token.value, ev(rule, `Stylesheet @${rule.name}`));
          else if (token.type === 'function' && token.value.toLowerCase() === 'url') add(valueParser.stringify(token.nodes).replace(/^(['"])(.*)\1$/, '$2'), ev(rule, `Stylesheet @${rule.name} url()`));
        }
      });
      root.walkDecls(declaration => {
        valueParser(declaration.value).walk(token => {
          if (token.type === 'function' && token.value.toLowerCase() === 'url') add(valueParser.stringify(token.nodes).trim().replace(/^(['"])(.*)\1$/, '$2'), ev(declaration, 'Stylesheet url()'));
        });
      });
    } catch { diagnostics.push('Stylesheet parse error; references may be incomplete'); }
  } else if (['.html', '.htm'].includes(extension)) {
    const root = parse(text, { sourceCodeLocationInfo: true });
    const visit = (node: any) => {
      for (const attribute of node.attrs ?? []) {
        if (!['src', 'href', 'poster'].includes(attribute.name)) continue;
        if (attribute.name === 'href' && !/\.[a-z0-9]+(?:[?#].*)?$/i.test(attribute.value)) continue;
        const loc = node.sourceCodeLocation?.attrs?.[attribute.name];
        add(attribute.value, { rule: `HTML ${attribute.name}`, range: loc ? { start: { line: loc.startLine - 1, character: loc.startCol - 1 }, end: { line: loc.endLine - 1, character: loc.endCol - 1 } } : undefined });
      }
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(root);
  } else if (['.vue', '.svelte', '.astro', '.mdx', '.graphql', '.gql'].includes(extension)) {
    diagnostics.push(`${extension}: indexed as a file; internal-reference analysis is not implemented`);
  }
  return { references, diagnostics };
}
