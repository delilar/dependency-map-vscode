export const DEFAULT_GROUP_COLOR = '#eab308';
export function normalizeHexColor(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}
export interface EditableGroup { id: string; name: string; color: string }
export class GroupDraft {
  groupId?: string;
  name = '';
  color = DEFAULT_GROUP_COLOR;
  dirty = false;

  sync(group?: EditableGroup, requestedId = group?.id): void {
    if (requestedId !== this.groupId) {
      this.groupId = requestedId;
      this.name = group?.name ?? '';
      this.color = normalizeHexColor(group?.color ?? '') ?? DEFAULT_GROUP_COLOR;
      this.dirty = false;
    } else if (!this.dirty && group) {
      this.name = group.name;
      this.color = normalizeHexColor(group.color) ?? DEFAULT_GROUP_COLOR;
    }
  }
  setName(name: string): void { this.name = name; this.dirty = true; }
  setColor(color: string): void {
    const normalized = normalizeHexColor(color);
    if (normalized) { this.color = normalized; this.dirty = true; }
  }
  saved(): void { this.dirty = false; }
  get valid(): boolean { return !!this.name.trim() && this.name.trim().length <= 200 && !!normalizeHexColor(this.color); }
}

export class PaletteDraft {
  committed: string;
  candidate: string;
  open = false;
  constructor(color = DEFAULT_GROUP_COLOR) { this.committed = this.candidate = normalizeHexColor(color) ?? DEFAULT_GROUP_COLOR; }
  begin(): void { this.candidate = this.committed; this.open = true; }
  setCandidate(value: string): void { this.candidate = value; }
  sync(color: string): void {
    const normalized = normalizeHexColor(color);
    if (normalized && !this.open) this.committed = this.candidate = normalized;
  }
  confirm(): string | undefined {
    if (!this.open) return;
    const normalized = normalizeHexColor(this.candidate);
    if (!normalized) return;
    this.committed = this.candidate = normalized;
    this.open = false;
    return normalized;
  }
  cancel(): void { this.candidate = this.committed; this.open = false; }
}
