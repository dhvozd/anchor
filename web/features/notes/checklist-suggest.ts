import { LIST_FORMATS, type QuillDelta } from "./quill";
import {
  type DeltaLine,
  deltaToLines,
  getLineLength,
  getLineStartPosition,
  getLineText,
  indentOf,
  isCheckedLine,
  isChecklistLine,
} from "./quill-lines";

export const MIN_QUERY_LENGTH = 2;
export const MAX_SUGGESTIONS = 5;

export type ChecklistSuggestion = { lineIndex: number; text: string };

/**
 * A word: starts with a letter or digit, then any letters, combining marks
 * and digits. A lone mark (the emoji variation selector) is not a word.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;

const wordsOf = (text: string) => text.toLowerCase().match(WORD) ?? [];

/**
 * The parts of [text] to emphasise for [query]: the start of each word that a
 * query word prefixes, as [start, end) UTF-16 offsets. One range per word, so
 * they come sorted and never overlap.
 */
export function matchedRanges(
  text: string,
  query: string,
): Array<[start: number, end: number]> {
  const words = wordsOf(query);
  const ranges: Array<[start: number, end: number]> = [];
  for (const { 0: word, index } of text.matchAll(WORD)) {
    const lower = word.toLowerCase();
    const length = Math.max(
      0,
      ...words.filter((w) => lower.startsWith(w)).map((w) => w.length),
    );
    // Lowercasing can lengthen a word (İ), so stay inside it.
    if (length) ranges.push([index, index + Math.min(length, word.length)]);
  }
  return ranges;
}

/** Links and embeds (non-string inserts) cannot be replaced by plain text. */
function hasRichContent(line: DeltaLine): boolean {
  return line.contentOps.some(
    (op) => typeof op.insert !== "string" || op.attributes?.link,
  );
}

function hasCheckedAncestor(
  lines: DeltaLine[],
  index: number,
  groupStart: number,
): boolean {
  let indent = indentOf(lines[index]);
  for (let i = index - 1; i >= groupStart && indent > 0; i--) {
    const parentIndent = indentOf(lines[i]);
    if (parentIndent < indent) {
      if (isCheckedLine(lines[i])) return true;
      indent = parentIndent;
    }
  }
  return false;
}

/**
 * Checked checklist items matching what is typed on the caret line, best
 * first: ranked like the slash menu, the caret's own checklist before others,
 * duplicates collapsed to the first.
 */
export function findChecklistSuggestions(
  contents: QuillDelta,
  caretLineIndex: number,
): ChecklistSuggestion[] {
  const lines = deltaToLines(contents.ops);
  const caret = lines[caretLineIndex];
  if (!caret || !isChecklistLine(caret) || isCheckedLine(caret)) return [];
  if (hasRichContent(caret)) return [];
  const next = lines[caretLineIndex + 1];
  if (next && indentOf(next) > indentOf(caret)) return [];

  const query = getLineText(caret).trim();
  if ([...query].length < MIN_QUERY_LENGTH) return [];
  const words = wordsOf(query);
  if (!words.length) return [];
  const joined = words.join("");

  // A checklist is a run of checklist lines, known by its first line.
  let caretGroup = caretLineIndex;
  while (caretGroup > 0 && isChecklistLine(lines[caretGroup - 1])) caretGroup--;
  let groupStart = 0;
  const ranked: {
    lineIndex: number;
    text: string;
    rank: number;
    otherGroup: number;
  }[] = [];

  lines.forEach((line, lineIndex) => {
    if (!isChecklistLine(line)) {
      groupStart = lineIndex + 1;
      return;
    }
    if (!isCheckedLine(line)) return;
    if (hasCheckedAncestor(lines, lineIndex, groupStart)) return;

    const text = getLineText(line);
    const itemWords = wordsOf(text);
    const rank = itemWords.join("").startsWith(joined)
      ? 0
      : words.every((word) => itemWords.some((w) => w.startsWith(word)))
        ? 1
        : -1;
    if (rank < 0) return;
    ranked.push({
      lineIndex,
      text,
      rank,
      otherGroup: groupStart === caretGroup ? 0 : 1,
    });
  });

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.otherGroup - b.otherGroup ||
      a.lineIndex - b.lineIndex,
  );

  const seen = new Set<string>();
  const result: ChecklistSuggestion[] = [];
  for (const { lineIndex, text } of ranked) {
    const key = text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ lineIndex, text });
    if (result.length === MAX_SUGGESTIONS) break;
  }
  return result;
}

export type RevivePlan = {
  remove: QuillDelta;
  uncheck: QuillDelta;
  caret: number;
};

/**
 * The edit that revives a crossed-off item: delete the typed line, then flip
 * the item to unchecked. `remove` applies to [contents]; `uncheck` and `caret`
 * apply to the result of `remove`. Null when no current suggestion for the
 * caret line has exactly this text.
 */
export function planRevive(
  contents: QuillDelta,
  caretLineIndex: number,
  text: string,
): RevivePlan | null {
  const picked = findChecklistSuggestions(contents, caretLineIndex).find(
    (suggestion) => suggestion.text === text,
  );
  if (!picked) return null;

  const lines = deltaToLines(contents.ops);
  const typedStart = getLineStartPosition(lines, caretLineIndex);
  const typedLength = getLineLength(lines[caretLineIndex]);
  const isLast = caretLineIndex === lines.length - 1;

  const remove: QuillDelta["ops"] = [];
  if (!isLast) {
    if (typedStart > 0) remove.push({ retain: typedStart });
    remove.push({ delete: typedLength });
  } else {
    // Delete the previous newline and the typed text, so the typed line's
    // newline survives; give it back the previous line's formatting.
    remove.push({ retain: typedStart - 1 }, { delete: typedLength });
    const typedAttrs = lines[caretLineIndex].newlineOp.attributes ?? {};
    const previousAttrs = lines[caretLineIndex - 1].newlineOp.attributes ?? {};
    const attributes: Record<string, unknown> = { ...previousAttrs };
    for (const key of Object.keys(typedAttrs)) {
      if (!(key in previousAttrs)) attributes[key] = null;
    }
    remove.push(
      Object.keys(attributes).length
        ? { retain: 1, attributes }
        : { retain: 1 },
    );
  }

  const pickedNewline =
    getLineStartPosition(lines, picked.lineIndex) +
    getLineLength(lines[picked.lineIndex]) -
    1;
  const caret =
    picked.lineIndex > caretLineIndex
      ? pickedNewline - typedLength
      : pickedNewline;

  const uncheck: QuillDelta["ops"] = [];
  if (caret > 0) uncheck.push({ retain: caret });
  uncheck.push({ retain: 1, attributes: { list: LIST_FORMATS.UNCHECKED } });

  return { remove: { ops: remove }, uncheck: { ops: uncheck }, caret };
}
