export const ROLE_LABELS = {
  environment: 'Окружение', test: 'Тесты', mock: 'Моки', fixture: 'Тестовые данные', story: 'Storybook',
  config: 'Конфигурация', type: 'Типы', style: 'Стили', asset: 'Ресурсы', data: 'Данные', documentation: 'Документация',
  page: 'Страницы', layout: 'Макеты', route: 'Маршруты', hook: 'Хуки', component: 'Компоненты',
  store: 'Сторы', context: 'Контекст', provider: 'Провайдеры', api: 'API / клиенты', utility: 'Утилиты', entry: 'Точки входа', source: 'Исходный код'
} as const;

export type FileRole = keyof typeof ROLE_LABELS;
export const TEST_ROLES: ReadonlySet<string> = new Set<FileRole>(['test', 'mock', 'fixture']);
export function isTestRole(role: string | undefined): boolean { return role !== undefined && TEST_ROLES.has(role); }

export interface RoleContext { projectRelativePath?: string; next?: boolean }
export interface RoleAssignment { role: FileRole; roleReason: string }
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx|vue|svelte|astro)$/i;
const directories: Record<string, FileRole> = {
  hooks: 'hook', components: 'component', ui: 'component', store: 'store', stores: 'store',
  context: 'context', contexts: 'context', providers: 'provider', api: 'api', clients: 'api',
  utils: 'utility', helpers: 'utility', utilities: 'utility', types: 'type', interfaces: 'type',
  pages: 'page', layouts: 'layout', routes: 'route'
};

export function classifyFile(filePath: string, context: RoleContext = {}): RoleAssignment | undefined {
  const relative = normalize(context.projectRelativePath ?? filePath);
  const parts = relative.split('/');
  const basename = parts.at(-1) ?? '';
  const lower = basename.toLowerCase();
  const folders = parts.slice(0, -1).map(part => part.toLowerCase());
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const known = (role: FileRole, rule: string): RoleAssignment => ({ role, roleReason: rule });
  const convention = (role: FileRole, rule: string) => known(role, `По соглашению ${rule}; runtime-назначение не проверяется`);

  if (/^\.env(?:\.|$)/i.test(basename)) return known('environment', 'Имя файла .env / .env.*; значения переменных не используются для определения роли');
  if (/\.(?:test|spec|cy)\./i.test(basename)) return convention('test', 'имени тестового файла');
  if (/\.mock\./i.test(basename) || folders.some(folder => ['mocks', '__mocks__'].includes(folder))) return convention('mock', 'имени или каталога mocks / __mocks__');
  if (/\.fixture\./i.test(basename) || extension === '.snap' || folders.some(folder => ['fixtures', '__fixtures__', '__snapshots__'].includes(folder))) return convention('fixture', 'имени или каталога тестовых данных');
  if (/\.(?:stories|story)\./i.test(basename)) return convention('story', 'имени Storybook-файла');
  if (folders.some(folder => ['test', 'tests', '__tests__', 'e2e', 'cypress'].includes(folder))) return convention('test', 'каталога тестов');

  if (/^(?:package\.json|(?:ts|js)config(?:\.[^.]+)*\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|lerna\.json|dockerfile|jenkinsfile|makefile)$/i.test(basename)
    || /(?:^|[.-])config(?:[.-]|$)/i.test(basename)
    || /^\.(?:eslintrc|prettierrc|babelrc|npmrc|yarnrc|editorconfig|browserslistrc)(?:\.|$)/i.test(basename)
    || folders.includes('.storybook') || folders.some((folder, index) => folder === '.github' && folders[index + 1] === 'workflows')) return convention('config', 'известного имени конфигурации');
  if (/\.d\.[cm]?ts$/i.test(basename)) return known('type', 'Расширение файла объявления TypeScript');
  if (['.css', '.scss', '.sass', '.less', '.styl'].includes(extension)) return known('style', `Формат стилей ${extension}`);
  if (['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.wasm', '.glsl', '.vert', '.frag'].includes(extension)) return known('asset', `Формат ресурса ${extension}`);
  if (['.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.csv', '.graphql', '.gql'].includes(extension)) return known('data', `Формат данных ${extension}; содержимое не доказывает назначение`);
  if (['.md', '.mdx', '.markdown', '.rst', '.adoc'].includes(extension) || /^readme(?:\.|$)/i.test(basename)) return known('documentation', `Документный формат или имя ${extension || 'README'}`);
  if (!sourcePattern.test(basename)) return undefined;

  const stem = basename.replace(/\.(?:[cm]?[jt]s|[jt]sx|vue|svelte|astro)$/i, '');
  if (context.next) {
    const frameworkPath = relative.replace(/^src\//, '');
    if (frameworkPath.startsWith('pages/api/')) return convention('route', 'Next.js Pages API route');
    if (frameworkPath.startsWith('pages/')) {
      if (stem === '_app') return convention('entry', 'Next.js Pages _app');
      if (stem === '_document') return convention('layout', 'Next.js Pages _document');
      return convention('page', 'Next.js Pages Router');
    }
    if (frameworkPath.startsWith('app/')) {
      if (stem === 'page') return convention('page', 'Next.js App Router page');
      if (['layout', 'template'].includes(stem)) return convention('layout', `Next.js App Router ${stem}`);
      if (stem === 'route') return convention('route', 'Next.js App Router route');
      if (['loading', 'error', 'global-error', 'not-found', 'default'].includes(stem)) return convention('component', `Next.js App Router ${stem}`);
    }
    if (['middleware', 'proxy'].includes(stem) && !frameworkPath.includes('/')) return convention('route', `Next.js ${stem}`);
  }
  if (/(?:^|\.)(?:types|interfaces)$/i.test(stem)) return convention('type', 'суффикса types / interfaces');
  const suffixRoles: [RegExp, FileRole][] = [
    [/\.store$/i, 'store'], [/\.context$/i, 'context'], [/\.provider$/i, 'provider'], [/\.api$/i, 'api'],
    [/\.component$/i, 'component'], [/\.hook$/i, 'hook'], [/\.(?:utils|helpers)$/i, 'utility']
  ];
  for (const [pattern, role] of suffixRoles) if (pattern.test(stem)) return convention(role, `суффикса ${stem.split('.').at(-1)}`);
  if (/^use[A-Z0-9]/.test(stem)) return convention('hook', 'имени use…; соблюдение React Rules of Hooks не проверяется');
  for (const folder of [...folders].reverse()) if (directories[folder]) return convention(directories[folder], `пути: каталог ${folder}`);
  if (/^(?:src\/)?(?:main|index|bootstrap)\.(?:[cm]?[jt]s|[jt]sx)$/.test(relative)) return convention('entry', 'корневого имени main / index / bootstrap');
  return known('source', `Исходный код ${extension}; конкретное назначение не определено`);
}
