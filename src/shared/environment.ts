import type { EnvKey } from './model';

export function extractEnvironmentKeys(text: string): EnvKey[] {
  const keys: EnvKey[] = [];
  let multilineQuote: string | undefined;
  const closes = (value: string, quote: string, offset: number) => {
    for (let index = offset; index < value.length; index++) if (value[index] === quote) {
      let slashes = 0;
      for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous--) slashes++;
      if (slashes % 2 === 0) return true;
    }
    return false;
  };
  for (const [line, value] of text.split(/\r?\n/).entries()) {
    if (multilineQuote) { if (closes(value, multilineQuote, 0)) multilineQuote = undefined; continue; }
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(value);
    if (!match) continue;
    const character = value.indexOf(match[1]);
    keys.push({ name: match[1], range: { start: { line, character }, end: { line, character: character + match[1].length } } });
    const right = value.slice(match[0].length).trimStart();
    if (['"', "'", '`'].includes(right[0]) && !closes(right, right[0], 1)) multilineQuote = right[0];
  }
  return keys;
}
