import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFile, isTestRole, ROLE_LABELS, type FileRole, type RoleContext } from '../../src/shared/roles';

test('frontend role catalog classifies formats and explicit conventions with an explanation', () => {
  const examples: [string, FileRole, RoleContext?][] = [
    ['.env.test.local', 'environment'], ['src/hooks/useCustomer.test.tsx', 'test'], ['src/__mocks__/api.ts', 'mock'],
    ['test/fixtures/photo.png', 'fixture'], ['src/components/Button.stories.tsx', 'story'], ['.storybook/main.ts', 'config'],
    ['src/models/User.d.ts', 'type'], ['src/components/Button.module.scss', 'style'], ['public/logo.svg', 'asset'],
    ['src/api/data.json', 'data'], ['docs/README.md', 'documentation'], ['src/app/profile/page.tsx', 'page', { next: true }],
    ['src/app/profile/layout.tsx', 'layout', { next: true }], ['src/pages/api/user.ts', 'route', { next: true }],
    ['src/hooks/useSession.ts', 'hook'], ['src/components/Button.tsx', 'component'], ['src/stores/cart.ts', 'store'],
    ['src/context/Session.tsx', 'context'], ['src/providers/SessionProvider.tsx', 'provider'], ['src/api/user.ts', 'api'],
    ['src/utils/math.ts', 'utility'], ['apps/web/src/main.tsx', 'entry', { projectRelativePath: 'src/main.tsx' }], ['src/Feature.tsx', 'source']
  ];
  for (const [file, role, context] of examples) {
    const assigned = classifyFile(file, context);
    assert.equal(assigned?.role, role, file);
    assert(assigned?.roleReason.length, `Missing role reason: ${file}`);
    assert(ROLE_LABELS[role]);
  }
  const convention = classifyFile('src/components/Button.tsx')!;
  assert(convention.roleReason.includes('По соглашению'));
  assert(convention.roleReason.includes('runtime-назначение не проверяется'));
});

test('role priority preserves tests, configuration and formats before functional hints', () => {
  const examples: [string, FileRole][] = [
    ['src/hooks/useSession.test.ts', 'test'], ['src/components/response.fixture.json', 'fixture'],
    ['.storybook/Palette.stories.mdx', 'story'], ['.storybook/main.ts', 'config'],
    ['src/components/Profile.types.ts', 'type'], ['src/hooks/types/Session.ts', 'type'],
    ['src/stores/helpers/math.ts', 'utility'], ['src/components/useSession.ts', 'hook'],
    ['src/store/Session.provider.tsx', 'provider'], ['src/__mocks__/User.d.ts', 'mock'],
    ['src/api/theme.scss', 'style'], ['src/components/main.tsx', 'component']
  ];
  for (const [file, role] of examples) assert.equal(classifyFile(file)?.role, role, file);
});

test('role hints use complete path segments and do not infer runtime components, stores or hooks', () => {
  for (const file of ['src/User.tsx', 'src/use-case.ts', 'src/useuser.ts', 'src/used.ts', 'src/apiary/client.ts', 'src/stores-old/value.ts', 'src/components-old/Foo.tsx', 'src/contests/index.ts']) {
    assert.equal(classifyFile(file)?.role, 'source', file);
  }
  assert.equal(classifyFile('src/app/page.tsx')?.role, 'source');
  assert.equal(classifyFile('src/app/page.tsx', { next: true })?.role, 'page');
  assert.equal(classifyFile('packages/components/src/Feature.tsx', { projectRelativePath: 'src/Feature.tsx' })?.role, 'source');
  assert.equal(classifyFile('src\\components\\Button.tsx')?.role, 'component');
  assert.equal(classifyFile('.ENV.LOCAL')?.role, 'environment');
  assert.equal(classifyFile('.github-old/workflows/build.yml')?.role, 'data');
  assert.equal(classifyFile('unknown.resource'), undefined);
});

test('hide-tests role family is explicit and separate from Storybook and ordinary source', () => {
  for (const role of ['test', 'mock', 'fixture']) assert.equal(isTestRole(role), true);
  for (const role of ['story', 'source', 'contest', 'testing', 'component', undefined]) assert.equal(isTestRole(role), false);
});
