export interface PanelSizes {
  leftWidth?: number; rightWidth?: number; toolbarHeight?: number;
  leftTopHeight?: number; rightTopHeight?: number; narrowCanvasHeight?: number;
}
const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
export function clampPanelSizes(saved: PanelSizes, width: number, height: number): Required<PanelSizes> {
  const narrow = width < 760;
  height = narrow ? Math.max(height, 346) : Math.max(height, 190);
  const left = clamp(saved.leftWidth ?? (width < 1000 ? 195 : 235), 150, narrow ? width - 156 : width - 472);
  const right = clamp(saved.rightWidth ?? (width < 1000 ? 265 : 305), 200, width - left - 272);
  const panelHeight = narrow ? Math.max(160, height - (saved.narrowCanvasHeight ?? height * 0.5) - 6) : height;
  return { leftWidth: left, rightWidth: right, toolbarHeight: clamp(saved.toolbarHeight ?? (width < 1200 ? 88 : 48), 44, Math.min(200, height * 0.35)),
    leftTopHeight: clamp(saved.leftTopHeight ?? 330, 85, panelHeight - 86), rightTopHeight: clamp(saved.rightTopHeight ?? 360, 100, panelHeight - 100),
    narrowCanvasHeight: clamp(saved.narrowCanvasHeight ?? height * 0.5, 180, height - 166) };
}

export function createSplitter(name: string, orientation: 'horizontal' | 'vertical', read: () => number, write: (value: number) => void,
  commit: () => void, reverse = false): HTMLDivElement {
  const handle = document.createElement('div'); handle.className = `splitter splitter-${orientation}`;
  handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', name); handle.setAttribute('aria-orientation', orientation);
  let origin = 0, initial = 0, dragging = false;
  const move = (event: PointerEvent) => {
    if (!dragging) return;
    const current = orientation === 'vertical' ? event.clientX : event.clientY;
    write(initial + (current - origin) * (reverse ? -1 : 1));
    handle.setAttribute('aria-valuenow', String(Math.round(read())));
  };
  const finish = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    commit();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); dragging = true; origin = orientation === 'vertical' ? event.clientX : event.clientY; initial = read();
    handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); handle.focus();
  });
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  handle.addEventListener('keydown', event => {
    const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== decrease && event.key !== increase) return;
    event.preventDefault(); const direction = (event.key === increase ? 1 : -1) * (reverse ? -1 : 1);
    write(read() + direction * (event.shiftKey ? 40 : 10)); handle.setAttribute('aria-valuenow', String(Math.round(read()))); commit();
  });
  return handle;
}

export class PanelLayout {
  private sizes: PanelSizes;
  private effective: Required<PanelSizes>;
  private observer: ResizeObserver;
  private frame = 0;
  readonly handles: { toolbar: HTMLDivElement; left: HTMLDivElement; right: HTMLDivElement; leftTop: HTMLDivElement; rightTop: HTMLDivElement; narrowCanvas: HTMLDivElement };
  constructor(private shell: HTMLElement, private workspace: HTMLElement, saved: PanelSizes | undefined, commit: () => void) {
    this.sizes = { ...saved }; this.effective = clampPanelSizes(this.sizes, shell.clientWidth, workspace.clientHeight);
    const handle = (key: keyof PanelSizes, title: string, orientation: 'horizontal' | 'vertical', reverse = false) => createSplitter(title, orientation,
      () => this.effective[key], value => { this.sizes[key] = value; this.apply(); this.sizes[key] = this.effective[key]; }, commit, reverse);
    this.handles = {
      toolbar: handle('toolbarHeight', 'Высота панели управления', 'horizontal'),
      left: handle('leftWidth', 'Ширина поиска и фильтров', 'vertical'), right: handle('rightWidth', 'Ширина деталей и групп', 'vertical', true),
      leftTop: handle('leftTopHeight', 'Высота фильтров', 'horizontal'), rightTop: handle('rightTopHeight', 'Высота групп задач', 'horizontal'),
      narrowCanvas: handle('narrowCanvasHeight', 'Высота карты', 'horizontal')
    };
    this.handles.left.classList.add('left-divider'); this.handles.right.classList.add('right-divider');
    this.handles.narrowCanvas.classList.add('narrow-divider');
    this.observer = new ResizeObserver(() => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.apply(); });
    });
    this.observer.observe(shell); this.observer.observe(workspace); this.apply();
  }
  private apply(): void {
    this.effective = clampPanelSizes(this.sizes, this.shell.clientWidth, this.workspace.clientHeight);
    for (const [key, value] of Object.entries(this.effective)) this.shell.style.setProperty(`--panel-${key}`, `${value}px`);
    for (const [name, key] of [['toolbar', 'toolbarHeight'], ['left', 'leftWidth'], ['right', 'rightWidth'], ['leftTop', 'leftTopHeight'], ['rightTop', 'rightTopHeight'], ['narrowCanvas', 'narrowCanvasHeight']] as const) {
      this.handles?.[name].setAttribute('aria-valuenow', String(Math.round(this.effective[key])));
    }
  }
  state(): PanelSizes { return { ...this.sizes }; }
  destroy(): void { this.observer.disconnect(); cancelAnimationFrame(this.frame); }
}
