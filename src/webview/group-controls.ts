import type { AnnotationGroup } from '../host/annotations';
import type { AnnotationResult } from '../shared/protocol';
import { GroupDraft } from './group-draft';
import { createColorPalette } from './palette';
import { DEFAULT_GROUP_COLOR } from './group-draft';

export interface GroupCommand {
  action: 'createGroup' | 'createGroupAndMark' | 'updateGroup' | 'deleteGroup' | 'mark' | 'unmark' | 'markFolder';
  requestId: string; groupId?: string; name?: string; color?: string; nodeIds?: string[]; relationIds?: string[];
}
export interface GroupControlsState {
  groups: readonly AnnotationGroup[];
  activeGroupId?: string;
  selection: { nodeIds: string[]; relationIds: string[] };
  error?: string;
  result?: AnnotationResult;
}
export interface GroupControls {
  element: HTMLElement;
  update(state: GroupControlsState): void;
  hasDraft(): boolean;
  saveDraft(): Promise<boolean>;
  discardDraft(): void;
  destroy(): void;
}

export function createGroupControls(callbacks: { activateGroup(groupId?: string): void; command(command: GroupCommand): void }): GroupControls {
  let state: GroupControlsState = { groups: [], selection: { nodeIds: [], relationIds: [] } };
  const draft = new GroupDraft();
  let pending: GroupCommand | undefined;
  let feedback = '';
  let feedbackError = false;
  let sequence = 0;
  let awaitingSave: { requestId: string; resolve(ok: boolean): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const element = document.createElement('section'); element.className = 'group-controls';
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
  const label = (text: string, control: HTMLElement) => { const item = make('label'); item.className = 'control'; item.append(make('span', text), control); control.setAttribute('aria-label', text); return item; };
  const button = (text: string, action: () => void) => { const item = make('button', text); item.type = 'button'; item.addEventListener('click', action); return item; };
  const selectionExists = () => state.selection.nodeIds.length + state.selection.relationIds.length > 0;
  const active = () => state.groups.find(group => group.id === state.activeGroupId);
  const issue = (action: GroupCommand['action'], extras: Partial<GroupCommand> = {}) => {
    if (pending) return;
    pending = { action, requestId: `${Date.now().toString(36)}-${++sequence}`, groupId: state.activeGroupId,
      nodeIds: [...new Set(state.selection.nodeIds)], relationIds: [...new Set(state.selection.relationIds)], ...extras };
    feedback = 'Сохранение…'; feedbackError = false; render();
    try { callbacks.command(pending); }
    catch { pending = undefined; feedback = 'Не удалось отправить действие. Повторите попытку.'; feedbackError = true; render(); }
  };

  const groupSelect = make('select');
  groupSelect.addEventListener('change', () => { deleteConfirm.hidden = true; callbacks.activateGroup(groupSelect.value || undefined); });
  const groupName = make('input'); groupName.type = 'text'; groupName.maxLength = 200; groupName.placeholder = 'Например, переделка авторизации';
  groupName.addEventListener('input', () => { draft.setName(groupName.value); renderActions(); });
  const palette = createColorPalette(draft.color, color => { draft.setColor(color); renderActions(); });
  const colorControl = make('div'); colorControl.className = 'control'; colorControl.setAttribute('role', 'group'); colorControl.setAttribute('aria-label', 'Цвет группы'); colorControl.append(make('span', 'Цвет группы'), palette.element);
  const properties = make('div'); properties.className = 'group-properties';
  const propertiesTitle = make('h3', 'Свойства группы');
  const propertiesHint = make('p', 'Имя и цвет относятся ко всей группе. Выбранные элементы добавляются отдельным действием.'); propertiesHint.className = 'hint';
  const metadataActions = make('div'); metadataActions.className = 'actions';
  const createEmpty = button('Создать пустую группу', () => { if (draft.valid) issue('createGroup', { groupId: undefined, name: draft.name.trim(), color: draft.color, nodeIds: [], relationIds: [] }); });
  const createMarked = button('Создать группу и пометить выбранное', () => { if (draft.valid && selectionExists()) issue('createGroupAndMark', { groupId: undefined, name: draft.name.trim(), color: draft.color }); });
  const saveProperties = button('Сохранить свойства группы', () => { if (draft.valid && active()) issue('updateGroup', { name: draft.name.trim(), color: draft.color, nodeIds: [], relationIds: [] }); });
  const deleteGroup = button('Удалить группу', () => { deleteConfirm.hidden = !deleteConfirm.hidden; });
  metadataActions.append(createEmpty, createMarked, saveProperties, deleteGroup);
  const deleteConfirm = make('div'); deleteConfirm.className = 'confirm'; deleteConfirm.hidden = true;
  deleteConfirm.append(make('p', 'Удалить группу вместе с её пометками и заметками?'), button('Удалить группу и пометки', () => { issue('deleteGroup', { nodeIds: [], relationIds: [] }); deleteConfirm.hidden = true; }), button('Оставить группу', () => { deleteConfirm.hidden = true; }));
  const validation = make('p'); validation.className = 'hint'; validation.setAttribute('aria-live', 'polite');
  properties.append(propertiesTitle, label('Название группы', groupName), colorControl, metadataActions, validation, propertiesHint, deleteConfirm);

  const selectionSection = make('section'); selectionSection.className = 'group-selection';
  const selectionTitle = make('h3', 'Выбранные элементы');
  const selectionSummary = make('p'); selectionSummary.className = 'small'; selectionSummary.setAttribute('aria-live', 'polite');
  const markActions = make('div'); markActions.className = 'actions';
  const mark = button('Добавить выбранное в группу', () => issue('mark'));
  const unmark = button('Убрать пометку и заметку', () => issue('unmark'));
  const folder = button('Добавить файлы папки', () => issue('markFolder', { relationIds: [] }));
  folder.title = 'Добавить снимок текущих файлов папки выбранного файла. Будущие файлы автоматически не добавляются.';
  markActions.append(mark, unmark, folder);
  const selectionHint = make('p', 'Цвет задачи — рамка файла или линия связи. Заливка показывает формат файла.'); selectionHint.className = 'hint';
  const status = make('p'); status.className = 'group-feedback'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  selectionSection.append(selectionTitle, selectionSummary, markActions, selectionHint);
  element.append(make('h2', 'Группы задач'), label('Активная группа', groupSelect), properties, selectionSection, status);

  function renderActions(): void {
    const group = active();
    const blocked = !!pending;
    const selected = selectionExists();
    createEmpty.hidden = createMarked.hidden = !!group;
    saveProperties.hidden = deleteGroup.hidden = !group;
    createEmpty.disabled = createMarked.disabled = blocked || !draft.valid;
    createMarked.disabled ||= !selected;
    saveProperties.disabled = blocked || !draft.valid || !draft.dirty;
    deleteGroup.disabled = blocked;
    mark.disabled = unmark.disabled = blocked || !group || !selected;
    folder.disabled = blocked || !group || state.selection.nodeIds.length !== 1;
    groupSelect.disabled = groupName.disabled = !!pending;
    palette.setDisabled(!!pending);
    groupName.setAttribute('aria-invalid', String(!draft.name.trim()));
    validation.textContent = !draft.name.trim() ? 'Для создания группы введите название.' : draft.dirty ? 'Есть несохранённые свойства группы.' : '';
    mark.title = group ? `Добавить выбранные элементы в «${group.name}»; цвет ${group.color}` : 'Выберите группу или создайте новую.';
    unmark.title = 'Удалить выбранные пометки из активной группы вместе с их заметками. Другие группы сохраняются.';
    selectionSummary.textContent = `Выбрано: файлов ${state.selection.nodeIds.length}, связей ${state.selection.relationIds.length}${group ? ` · группа «${group.name}»` : ' · группа не выбрана'}`;
    status.textContent = state.error ?? feedback;
    status.classList.toggle('error', !!state.error || feedbackError);
  }
  function render(): void {
    const options = [['', 'Новая группа'], ...state.groups.map(group => [group.id, group.name])];
    if (groupSelect.options.length !== options.length || Array.from(groupSelect.options).some((option, index) => option.value !== options[index][0] || option.textContent !== options[index][1])) {
      groupSelect.replaceChildren(...options.map(([value, text]) => { const option = make('option', text); option.value = value; return option; }));
    }
    groupSelect.value = state.activeGroupId ?? '';
    if (groupName.value !== draft.name) groupName.value = draft.name;
    palette.setValue(draft.color);
    renderActions();
  }
  render();
  return {
    element,
    update(next) {
      const changedGroup = state.activeGroupId !== next.activeGroupId;
      state = next;
      if (changedGroup) { palette.cancel(false); deleteConfirm.hidden = true; }
      draft.sync(active(), state.activeGroupId);
      const result = next.result;
      if (result && pending?.requestId === result.requestId) {
        if (result.ok && ['createGroup', 'createGroupAndMark', 'updateGroup'].includes(result.action)) draft.saved();
        pending = undefined; feedback = result.message; feedbackError = !result.ok;
        if (awaitingSave?.requestId === result.requestId) { clearTimeout(awaitingSave.timer); awaitingSave.resolve(result.ok); awaitingSave = undefined; }
      }
      render();
    },
    hasDraft() { return draft.dirty || !!pending; },
    saveDraft() {
      if (!draft.dirty) return Promise.resolve(!pending);
      if (pending || !draft.valid) return Promise.resolve(false);
      return new Promise(resolve => {
        issue(active() ? 'updateGroup' : 'createGroup', { name: draft.name.trim(), color: draft.color, nodeIds: [], relationIds: [] });
        if (!pending) { resolve(false); return; }
        const requestId = pending.requestId;
        awaitingSave = { requestId, resolve, timer: setTimeout(() => { if (awaitingSave?.requestId === requestId) { awaitingSave = undefined; resolve(false); } }, 15000) };
      });
    },
    discardDraft() {
      palette.cancel(false);
      const group = active(); draft.name = group?.name ?? ''; draft.color = group?.color ?? DEFAULT_GROUP_COLOR; draft.dirty = false;
      render();
    },
    destroy() { if (awaitingSave) { clearTimeout(awaitingSave.timer); awaitingSave.resolve(false); } palette.destroy(); }
  };
}
