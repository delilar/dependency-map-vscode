import path from 'node:path';
import type { Root as PostcssRoot } from 'postcss';
import valueParser from 'postcss-value-parser';
import type { Evidence } from '../shared/model';
import type { Reference } from './javascript';

interface Located {
  source?: { start?: { line: number; column: number }; end?: { line: number; column: number } };
  lineno?: number; column?: number;
}
interface StylusNode extends Located {
  nodeName: string; nodes?: StylusNode[]; name?: string; val?: string | number | StylusNode;
  args?: StylusNode; path?: StylusNode; once?: boolean; [key: string]: unknown;
}
interface SassNode extends Located {
  sassType: string; type?: string; name?: string; quotes?: boolean; expression?: SassNode;
  nodes?: (SassNode | string)[]; nonStatementChildren?: SassNode[];
  text?: { nodes: (SassNode | string)[] }; arguments?: { nodes: { value: SassNode }[] };
  imports?: { nodes: SassNode[] }; useUrl?: string; forwardUrl?: string; url?: string;
  staticUrl?: { nodes: (SassNode | string)[] };
}

function evidence(node: Located, rule: string): Evidence {
  const start = node.source?.start ?? (node.lineno ? { line: node.lineno, column: node.column ?? 1 } : undefined);
  const end = node.source?.end;
  return { rule, range: start ? {
    start: { line: start.line - 1, character: start.column - 1 },
    end: end ? { line: end.line - 1, character: end.column } : { line: start.line - 1, character: start.column }
  } : undefined };
}
function local(value: string): boolean { return !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value); }
function plain(nodes: (SassNode | string)[] | undefined): string | undefined {
  return nodes?.every(node => typeof node === 'string') ? nodes.join('') : undefined;
}

export function extractAdditionalStyles(file: string, text: string): { references: Reference[]; diagnostics: string[] } {
  const references: Reference[] = [];
  const diagnostics: string[] = [];
  const extension = path.extname(file).toLowerCase();
  const add = (value: string | undefined, node: Located, rule: string, computed = false, inferred = false) => {
    if (computed || value === undefined) {
      references.push({ kind: 'resource', bindings: [], evidence: evidence(node, rule), reason: 'Computed stylesheet path; variables, interpolation and function evaluation are not executed' });
    } else if (local(value)) references.push({ specifier: value, kind: 'resource', bindings: [], evidence: evidence(node, rule), ...(inferred ? { certainty: 'inferred' } : {}) });
  };
  const tokens = (value: string) => valueParser(value).nodes.filter(token => token.type !== 'space' && token.type !== 'comment');
  const value = (raw: string, node: Located, rule: string, dialect: 'less' | 'sass') => {
    const parts = tokens(raw);
    const first = parts[0];
    if (!first) return add(undefined, node, rule);
    if (parts.length > 1 && parts.every(part => part.type === 'word' || (part.type === 'div' && part.value === '/')) && !/\s/.test(raw)) {
      return add(raw, node, rule, /^(?:@|\$)/.test(raw) || raw.includes('@{') || raw.includes('#{') || /[`()]/.test(raw));
    }
    if (parts.length !== 1) return add(undefined, node, rule);
    if (first.type === 'string') return add(first.value, node, rule, first.value.includes(dialect === 'less' ? '@{' : '#{'));
    if (first.type === 'word') return add(first.value, node, rule, /^(?:@|\$)/.test(first.value) || first.value.includes('@{') || first.value.includes('#{') || /[`()]/.test(first.value));
    add(undefined, node, rule);
  };
  const urls = (raw: string, node: Located, rule: string, dialect: 'less' | 'sass') => {
    valueParser(raw).walk(token => {
      if (token.type !== 'function' || token.value.toLowerCase() !== 'url') return;
      value(valueParser.stringify(token.nodes), node, rule, dialect);
      return false;
    });
  };

  try {
    if (extension === '.less') {
      const parser = require('postcss-less') as { parse(text: string, options: { from: string; map: false }): PostcssRoot };
      const root = parser.parse(text, { from: file, map: false });
      root.walkAtRules(rule => {
        if (rule.name.toLowerCase() !== 'import') return;
        const first = tokens(rule.params).find(token => token.type === 'string' || token.type === 'word' || (token.type === 'function' && token.value.toLowerCase() === 'url'));
        if (!first) return add(undefined, rule, 'Less @import');
        if (first.type === 'function') value(valueParser.stringify(first.nodes), rule, 'Less @import url()', 'less');
        else value(valueParser.stringify(first), rule, 'Less @import', 'less');
      });
      root.walkDecls(declaration => urls(declaration.value, declaration, 'Less url()', 'less'));
    } else if (extension === '.styl') {
      const Parser = require('stylus/lib/parser') as new (text: string, options: { cache: false; filename: string }) => { parse(): StylusNode };
      const root = new Parser(text, { cache: false, filename: file }).parse();
      const literal = (node: StylusNode | undefined): string | undefined => {
        if (!node) return;
        if (node.nodeName === 'expression' || node.nodeName === 'arguments') return node.nodes?.length === 1 ? literal(node.nodes[0]) : undefined;
        if ((node.nodeName === 'string' || node.nodeName === 'literal') && typeof node.val === 'string') return node.val;
        if (node.nodeName === 'call' && node.name?.toLowerCase() === 'url') return literal(node.args);
      };
      const seen = new Set<unknown>();
      const pending: unknown[] = [root];
      const ast: StylusNode[] = [];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        seen.add(item);
        const node = item as StylusNode;
        if (node.nodeName) ast.push(node);
        for (const [key, child] of Object.entries(item)) {
          if (['parent', 'node', 'source'].includes(key)) continue;
          if (Array.isArray(child)) pending.push(...child); else if (child && typeof child === 'object') pending.push(child);
        }
      }
      const bound = new Set(ast.filter(node => node.nodeName === 'ident' && node.val && typeof node.val === 'object' && node.val.nodeName !== 'null').map(node => node.name));
      const unwrap = (node: StylusNode | undefined): StylusNode | undefined => node && ['expression', 'arguments'].includes(node.nodeName) && node.nodes?.length === 1 ? unwrap(node.nodes[0]) : node;
      const inferredUrl = (node: StylusNode | undefined): string | undefined => {
        const expression = unwrap(node);
        const children = expression?.nodeName === 'expression' ? expression.nodes : undefined;
        if (!children?.some(child => child.nodeName === 'literal' && ['/', '.'].includes(String(child.val)))) return;
        if (!children.every(child => child.nodeName === 'literal' || (child.nodeName === 'ident' && !bound.has(child.name)))) return;
        return children.map(child => child.nodeName === 'ident' ? child.name : child.val).join('');
      };
      const importedUrls = new Set<StylusNode>();
      for (const node of ast.filter(item => item.nodeName === 'import')) {
        const target = unwrap(node.path);
        if (target?.nodeName === 'call' && target.name?.toLowerCase() === 'url') importedUrls.add(target);
        const raw = literal(node.path);
        const inferred = raw === undefined && target?.nodeName === 'call' ? inferredUrl(target.args) : undefined;
        const rule = `${node.once ? 'Stylus @require' : 'Stylus @import'}${inferred === undefined ? '' : ' (unquoted URL inference; imported bindings are not evaluated)'}`;
        add(raw ?? inferred, node.path?.nodes?.[0] ?? node, rule, false, inferred !== undefined);
      }
      for (const node of ast.filter(item => item.nodeName === 'call' && item.name?.toLowerCase() === 'url' && !importedUrls.has(item))) {
        const raw = literal(node.args);
        const inferred = raw === undefined ? inferredUrl(node.args) : undefined;
        add(raw ?? inferred, node.args?.nodes?.[0]?.nodes?.[0] ?? node, inferred === undefined ? 'Stylus url()' : 'Stylus unquoted URL inferred from syntax; imported bindings are not evaluated', false, inferred !== undefined);
      }
    } else if (extension === '.sass') {
      const parser = require('sass-parser') as { sass: { parse(text: string, options: { from: string }): { walk(callback: (node: SassNode) => void): void } } };
      const root = parser.sass.parse(text, { from: file });
      const expressions = (expression: SassNode | undefined) => {
        const seen = new Set<SassNode>();
        const pending = expression ? [expression] : [];
        while (pending.length) {
          const node = pending.pop()!;
          if (seen.has(node)) continue;
          seen.add(node);
          if (node.sassType === 'function-call' && node.name?.toLowerCase() === 'url') {
            const args = node.arguments?.nodes;
            const argument = args?.length === 1 ? args[0].value : undefined;
            const path = argument?.sassType === 'string' ? plain(argument.text?.nodes) : undefined;
            add(path, node, 'Indented Sass url()');
            continue;
          }
          if (node.sassType === 'string' && !node.quotes) {
            const raw = plain(node.text?.nodes);
            if (raw !== undefined) urls(raw, node, 'Indented Sass url()', 'sass');
            else if (node.text?.nodes.some(part => typeof part === 'string' && part.toLowerCase().includes('url('))) add(undefined, node, 'Indented Sass interpolated url()');
          }
          pending.push(...(node.nonStatementChildren ?? []));
          for (const child of node.nodes ?? []) if (typeof child !== 'string') pending.push(child);
        }
      };
      root.walk(node => {
        if (node.sassType === 'use-rule') add(node.useUrl, node, 'Indented Sass @use', node.useUrl?.includes('#{'));
        else if (node.sassType === 'forward-rule') add(node.forwardUrl, node, 'Indented Sass @forward', node.forwardUrl?.includes('#{'));
        else if (node.sassType === 'import-rule') {
          for (const imported of node.imports?.nodes ?? []) {
            if (imported.sassType === 'dynamic-import') add(imported.url, imported, 'Indented Sass @import');
            else {
              const raw = plain(imported.staticUrl?.nodes);
              if (raw === undefined) add(undefined, imported, 'Indented Sass computed @import');
              else {
                const first = tokens(raw)[0];
                if (first?.type === 'function' && first.value.toLowerCase() === 'url') value(valueParser.stringify(first.nodes), imported, 'Indented Sass @import url()', 'sass');
                else value(raw, imported, 'Indented Sass @import', 'sass');
              }
            }
          }
        } else if (node.sassType === 'decl') expressions(node.expression);
      });
    }
  } catch {
    diagnostics.push(`${extension} parse error; internal references may be incomplete`);
  }
  return { references, diagnostics };
}
