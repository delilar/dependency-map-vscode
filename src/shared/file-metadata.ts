import type { GraphNode } from './model';

export function fileMetadata(format: string, role?: string): Pick<GraphNode, 'family' | 'languageId'> {
  const ext = format.toLowerCase();
  const languageId = ({ '.tsx': 'TSX', '.jsx': 'JSX', '.ts': 'TS', '.mts': 'TS', '.cts': 'TS', '.js': 'JS', '.mjs': 'JS', '.cjs': 'JS', '.vue': 'VUE', '.svelte': 'SVELTE', '.astro': 'ASTRO', '.mdx': 'MDX', '.html': 'HTML', '.htm': 'HTML', '.graphql': 'GQL', '.gql': 'GQL', '.env': 'ENV' } as Record<string, string>)[ext] ?? ext.replace(/^\./, '').toUpperCase();
  const family = role === 'config' || role === 'environment' ? 'config'
    : ['.jsx', '.tsx', '.vue', '.svelte', '.astro', '.mdx', '.html', '.htm'].includes(ext) ? 'ui'
    : ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'].includes(ext) ? 'style'
    : ['.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.csv', '.graphql', '.gql', '.md', '.markdown'].includes(ext) ? 'data'
    : /\.(?:[cm]?[jt]s|[jt]sx)$/.test(ext) ? 'code' : 'resource';
  return { family, languageId };
}
