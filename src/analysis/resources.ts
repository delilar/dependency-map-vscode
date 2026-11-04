import path from 'node:path';
import postcss from 'postcss';
import scss from 'postcss-scss';
import valueParser from 'postcss-value-parser';
import { parse } from 'parse5';
import type { Evidence, SourceRange } from '../shared/model';
import { extractJavascript, type Reference } from './javascript';
import { extractAdditionalStyles } from './style-formats';
import parseSrcset from 'parse-srcset';
import { emptySourceResult, mergeSourceRegion } from './result-utils';
import { nativeResourceAttribute } from './html-resources';

export { extractEnvironmentKeys as extractEnvKeys } from '../shared/environment';
export function extractResources(file: string, text: string): { references: Reference[]; diagnostics: string[] } {
  if (['.sass', '.less', '.styl', '.stylus'].includes(path.extname(file).toLowerCase())) return extractAdditionalStyles(file.replace(/\.stylus$/i, '.styl'), text);
  const references: Reference[] = [];
  const diagnostics: string[] = [];
  const local = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
  const add = (value: string, evidence: Evidence) => {
    if (value.includes('#{') || value.includes('@{') || /^(?:\$|var\(|env\()/i.test(value)) {
      references.push({ kind: 'resource', bindings: [], evidence, reason: 'Computed stylesheet reference is not evaluated' }); return;
    }
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
          if (token.type === 'string') { add(token.value, ev(rule, `Stylesheet @${rule.name}`)); if (references.at(-1)?.specifier === token.value) Object.assign(references.at(-1)!, { resolutionMode: 'style', sourceExtension: extension }); }
          else if (token.type === 'function' && token.value.toLowerCase() === 'url') add(valueParser.stringify(token.nodes).replace(/^(['"])(.*)\1$/, '$2'), ev(rule, `Stylesheet @${rule.name} url()`));
        }
      });
      root.walkDecls(declaration => {
        if (declaration.prop === 'composes') {
          const tokens = valueParser(declaration.value).nodes;
          const from = tokens.findIndex(token => token.type === 'word' && token.value === 'from');
          const target = tokens.slice(from + 1).find(token => token.type === 'string');
          if (from >= 0 && target?.type === 'string') add(target.value, ev(declaration, 'CSS Modules composes from'));
        }
        valueParser(declaration.value).walk(token => {
          if (token.type === 'function' && token.value.toLowerCase() === 'url') add(valueParser.stringify(token.nodes).trim().replace(/^(['"])(.*)\1$/, '$2'), ev(declaration, 'Stylesheet url()'));
        });
      });
    } catch { diagnostics.push('Stylesheet parse error; references may be incomplete'); }
  } else if (['.html', '.htm'].includes(extension)) {
    const root = parse(text, { sourceCodeLocationInfo: true });
    let base: string | undefined;
    const visit = (node: any) => {
      if (node.tagName === 'base') { base ??= node.attrs?.find((item: any) => item.name === 'href')?.value; return; }
      for (const attribute of node.attrs ?? []) {
        if (!node.tagName || !nativeResourceAttribute(node.tagName, attribute.name)) continue;
        if (attribute.name === 'href' && !/\.[a-z0-9]+(?:[?#].*)?$/i.test(attribute.value)) continue;
        const loc = node.sourceCodeLocation?.attrs?.[attribute.name];
        const values = attribute.name === 'srcset' ? parseSrcset(attribute.value).map(item => item.url) : [attribute.value];
        for (const value of values) add(value, { rule: `HTML ${attribute.name}`, range: loc ? { start: { line: loc.startLine - 1, character: loc.startCol - 1 }, end: { line: loc.endLine - 1, character: loc.endCol - 1 } } : undefined });
      }
      if (['script', 'style'].includes(node.tagName) && !(node.attrs ?? []).some((item: any) => item.name === 'src')) {
        const type = node.attrs?.find((item: any) => item.name === 'type')?.value;
        if (node.tagName === 'style' && (!type || type === 'text/css') || node.tagName === 'script' && (!type || ['module', 'text/javascript', 'application/javascript'].includes(type))) {
          const start = node.sourceCodeLocation?.startTag?.endOffset, end = node.sourceCodeLocation?.endTag?.startOffset;
          if (start !== undefined && end !== undefined) {
            const embedded = node.tagName === 'style' ? extractResources(file + '.css', text.slice(start, end)) : extractJavascript(file + '.js', text.slice(start, end));
            const mapped = emptySourceResult();
            mergeSourceRegion(mapped, embedded, text, start, { exports: false });
            references.push(...mapped.references); diagnostics.push(...mapped.diagnostics);
          }
        }
      }
      for (const child of node.childNodes ?? []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(root);
    if (base !== undefined) for (const reference of references) if (reference.specifier) {
      if (!local(base)) reference.reason = 'External or embedded HTML base URL prevents local resolution';
      else if (!reference.specifier.startsWith('/')) {
        const directory = base.endsWith('/') ? base : path.posix.dirname(base);
        const target = path.posix.join(directory, reference.specifier);
        reference.specifier = target.startsWith('.') || target.startsWith('/') ? target : './' + target;
      }
    }
  } else if (['.vue', '.svelte', '.astro', '.mdx', '.graphql', '.gql'].includes(extension)) {
    diagnostics.push(`${extension}: indexed as a file; internal-reference analysis is not implemented`);
  }
  return { references, diagnostics };
}
