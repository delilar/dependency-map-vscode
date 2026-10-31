import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { GroupDraft, normalizeHexColor, PaletteDraft } from '../../src/webview/group-draft';

test('host snapshots preserve dirty name and color drafts until matching save or explicit group change', () => {
  const draft = new GroupDraft();
  const group = { id: 'auth', name: 'Auth', color: '#eab308' };
  draft.sync(group);
  draft.setName('Local draft'); draft.setColor('#FF0000');
  draft.sync({ ...group, name: 'External update', color: '#00ff00' });
  assert.equal(draft.name, 'Local draft');
  assert.equal(draft.color, '#ff0000');
  assert.equal(draft.dirty, true);
  draft.saved();
  draft.sync({ ...group, name: 'Saved draft', color: '#ff0000' });
  assert.equal(draft.name, 'Saved draft');
  draft.setName('Another draft');
  draft.sync(undefined, 'auth');
  assert.equal(draft.name, 'Another draft', 'temporarily missing host group does not destroy edits');
  draft.sync({ id: 'other', name: 'Other', color: '#123456' });
  assert.equal(draft.name, 'Other'); assert.equal(draft.dirty, false);
});

test('group draft validates required names and complete HEX colors', () => {
  const draft = new GroupDraft();
  assert.equal(draft.valid, false);
  draft.setName('   '); assert.equal(draft.valid, false);
  draft.setName('Task'); assert.equal(draft.valid, true);
  draft.setName('x'.repeat(201)); assert.equal(draft.valid, false);
  assert.equal(normalizeHexColor(' #Ab12Cd '), '#ab12cd');
  for (const value of ['', '#fff', 'red', 'url(javascript:test)', '#12345678', '#12gg56']) assert.equal(normalizeHexColor(value), undefined);
});

test('palette candidate does not commit on cancel, Escape-equivalent or host synchronization', () => {
  const draft = new PaletteDraft('#123456');
  draft.begin(); draft.setCandidate('#ff0000');
  draft.sync('#00ff00');
  assert.equal(draft.candidate, '#ff0000');
  assert.equal(draft.committed, '#123456');
  draft.cancel();
  assert.equal(draft.open, false);
  assert.equal(draft.committed, '#123456');
  assert.equal(draft.candidate, '#123456');
  assert.equal(draft.confirm(), undefined, 'closed palette cannot commit after focus restoration');
  draft.sync('#00ff00'); assert.equal(draft.committed, '#00ff00');
});

test('palette chooses only a valid explicit candidate and does not commit twice', () => {
  const draft = new PaletteDraft('#123456');
  draft.begin(); draft.setCandidate('#12');
  assert.equal(draft.confirm(), undefined); assert.equal(draft.open, true);
  draft.setCandidate('#ABCDEF');
  assert.equal(draft.confirm(), '#abcdef'); assert.equal(draft.open, false);
  assert.equal(draft.confirm(), undefined);
});
