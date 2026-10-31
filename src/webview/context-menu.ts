export class NodeDepthMenu {
  readonly element = document.createElement('section');
  private heading = document.createElement('h3');
  private select = document.createElement('select');
  private reset = document.createElement('button');
  private save = document.createElement('button');
  private hint = document.createElement('p');
  private opener?: HTMLElement;
  private nodeId?: string;
  private readonly branchButtons: HTMLButtonElement[] = [];
  private outside = (event: PointerEvent) => { if (!this.element.hidden && !this.element.contains(event.target as Node)) this.close(); };
  constructor(private apply: (nodeId: string, depth: number | null) => void,
    branch?: (nodeId: string, direction: 'incoming' | 'outgoing', action: 'expand' | 'collapse') => void) {
    this.element.className = 'node-menu'; this.element.hidden = true; this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Индивидуальная глубина узла');
    const label = document.createElement('label'); label.className = 'control'; label.textContent = 'Радиус от этой ноды';
    this.select.setAttribute('aria-label', 'Индивидуальная глубина');
    for (let depth = 1; depth <= 20; depth++) { const option = document.createElement('option'); option.value = String(depth); option.textContent = String(depth); this.select.append(option); }
    label.append(this.select);
    this.hint.className = 'hint';
    const buttons = document.createElement('div'); buttons.className = 'actions';
    const save = this.save; save.type = 'button'; save.textContent = 'Применить глубину'; save.addEventListener('click', () => { if (this.nodeId) this.apply(this.nodeId, Number(this.select.value)); this.close(); });
    this.reset.type = 'button'; this.reset.textContent = 'Сбросить для этой ноды'; this.reset.addEventListener('click', () => { if (this.nodeId) this.apply(this.nodeId, null); this.close(); });
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Закрыть'; cancel.addEventListener('click', () => this.close());
    const branches = document.createElement('div'); branches.className = 'actions';
    if (branch) for (const [direction, title] of [['incoming', 'входящие'], ['outgoing', 'исходящие']] as const) {
      for (const [action, text] of [['expand', `Ещё ${title}`], ['collapse', `Свернуть ${title}`]] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.addEventListener('click', () => { if (this.nodeId) branch(this.nodeId, direction, action); this.close(); });
        branches.append(button); this.branchButtons.push(button);
      }
    }
    buttons.append(save, this.reset, cancel); this.element.append(this.heading, branches, label, this.hint, buttons);
    this.element.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); this.close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(this.element.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select')).filter(control => !control.disabled);
        const index = controls.indexOf(document.activeElement as HTMLSelectElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
      }
    });
    document.addEventListener('pointerdown', this.outside);
  }
  open(nodeId: string, name: string, depth: number | undefined, point?: { x: number; y: number }, opener?: HTMLElement, enabled = true, bothDirections = true, branchesEnabled = enabled): void {
    this.nodeId = nodeId; this.opener = opener ?? document.activeElement as HTMLElement;
    this.heading.textContent = name; this.select.value = String(depth ?? 1); this.reset.disabled = depth === undefined || !enabled;
    this.save.disabled = this.select.disabled = !enabled;
    for (const button of this.branchButtons) button.disabled = !branchesEnabled;
    this.hint.textContent = !enabled ? 'В режиме проекта видны все доступные файлы. Перейдите в режим файла для настройки глубины.'
      : `Дополняет общую область. ${bothDirections ? 'В обе стороны — это окрестность графа: через общий узел можно достичь соседней ветки. Выберите исходящие связи для ветки импортов.' : 'Радиус считается по выбранному направлению.'}`;
    this.element.hidden = false; this.element.style.left = '0px'; this.element.style.top = '0px';
    const bounds = this.element.getBoundingClientRect();
    const origin = point ?? this.opener?.getBoundingClientRect();
    const x = origin ? 'x' in origin ? origin.x : 20 : 20, y = origin ? 'y' in origin ? origin.y : 20 : 20;
    this.element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    this.element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    (enabled ? this.select : this.element.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }
  close(): void { this.element.hidden = true; this.opener?.focus(); }
  destroy(): void { document.removeEventListener('pointerdown', this.outside); this.element.remove(); }
}
