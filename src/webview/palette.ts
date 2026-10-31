import { normalizeHexColor, PaletteDraft } from './group-draft';

export interface ColorPalette {
  element: HTMLElement;
  setValue(color: string): void;
  getValue(): string;
  setDisabled(disabled: boolean): void;
  cancel(returnFocus?: boolean): void;
  destroy(): void;
}

const swatches: [string, string][] = [
  ['#eab308', 'Жёлтый'], ['#f97316', 'Оранжевый'], ['#ef4444', 'Красный'], ['#e879a6', 'Розовый'],
  ['#a78bfa', 'Фиолетовый'], ['#60a5fa', 'Синий'], ['#22d3ee', 'Голубой'], ['#2dd4bf', 'Бирюзовый'],
  ['#4ade80', 'Зелёный'], ['#a3e635', 'Лаймовый'], ['#cbd5e1', 'Серый'], ['#ffffff', 'Белый']
];

export function createColorPalette(initialColor: string, onChange: (color: string) => void): ColorPalette {
  const draft = new PaletteDraft(initialColor);
  const element = document.createElement('div'); element.className = 'color-palette';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'color-trigger'; trigger.setAttribute('aria-label', 'Выбрать цвет группы'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'dialog');
  const swatch = document.createElement('span'); swatch.className = 'color-swatch'; swatch.setAttribute('aria-hidden', 'true');
  const triggerText = document.createElement('span'); trigger.append(swatch, triggerText);
  const panel = document.createElement('div'); panel.className = 'palette-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Выбор цвета');
  const palette = document.createElement('div'); palette.className = 'palette-swatches'; palette.setAttribute('aria-label', 'Готовые цвета');
  const inputLabel = document.createElement('label'); inputLabel.className = 'control'; inputLabel.append(document.createTextNode('HEX #RRGGBB'));
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = 7; input.spellcheck = false; input.autocomplete = 'off'; input.setAttribute('aria-label', 'HEX цвета'); input.placeholder = '#eab308'; inputLabel.append(input);
  const error = document.createElement('p'); error.className = 'error'; error.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div'); actions.className = 'actions';
  const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Выбрать цвет';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Отмена выбора цвета';
  actions.append(choose, cancel); panel.append(palette, inputLabel, error, actions); element.append(trigger, panel);

  const render = () => {
    swatch.style.backgroundColor = draft.committed; triggerText.textContent = draft.committed;
    panel.hidden = !draft.open; trigger.setAttribute('aria-expanded', String(draft.open));
    if (input.value !== draft.candidate) input.value = draft.candidate;
    const normalized = normalizeHexColor(draft.candidate);
    input.setAttribute('aria-invalid', String(!normalized));
    error.textContent = normalized ? '' : 'Введите цвет в формате #RRGGBB.';
    choose.disabled = !normalized;
    palette.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === normalized)));
  };
  const close = (returnFocus = true) => {
    draft.cancel(); render();
    if (returnFocus) trigger.focus({ preventScroll: true });
  };
  for (const [color, name] of swatches) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'palette-swatch'; button.dataset.color = color;
    button.setAttribute('aria-label', `${name} ${color}`); button.title = `${name} ${color}`; button.style.backgroundColor = color;
    button.addEventListener('click', () => { draft.setCandidate(color); render(); });
    palette.append(button);
  }
  trigger.addEventListener('click', () => {
    if (draft.open) { close(); return; }
    draft.begin(); render(); input.focus(); input.select();
  });
  input.addEventListener('input', () => { draft.setCandidate(input.value); render(); });
  choose.addEventListener('click', () => {
    const color = draft.confirm();
    if (!color) return;
    render(); trigger.focus({ preventScroll: true }); onChange(color);
  });
  cancel.addEventListener('click', () => close());
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !draft.open) return;
    event.preventDefault(); event.stopPropagation(); close();
  };
  const outside = (event: PointerEvent) => { if (draft.open && !element.contains(event.target as Node)) close(false); };
  document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
  render();
  return {
    element,
    setValue(color) { draft.sync(color); render(); }, getValue: () => draft.committed,
    setDisabled(disabled) { trigger.disabled = disabled; if (disabled && draft.open) close(false); },
    cancel: close,
    destroy() { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); }
  };
}
