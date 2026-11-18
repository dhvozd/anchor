import Delta from "quill-delta";
import { planRevive } from "../../checklist-suggest";
import type { QuillDelta, QuillOp } from "../../quill";
import {
  deltaToLines,
  findLineIndexAtPosition,
  getLineLength,
  getLineStartPosition,
} from "../../quill-lines";
import { planChecklistSort } from "./checklist-sort";

/**
 * Restoring a crossed-off item: `remove` applies to the contents, then
 * `revive` to the result; `caret` is in the final document.
 */
export type ReviveEdit = {
  remove: QuillDelta;
  revive: QuillDelta;
  caret: number;
};

/**
 * Restores a crossed-off item. With [sortChecked], `revive` also moves the
 * item where the checklist sort would, in the same delta, so a fold over the
 * checked items never splits. Null when no current suggestion for the caret
 * line has exactly this text (see planRevive).
 */
export function planReviveEdit(
  contents: QuillDelta,
  caretLineIndex: number,
  text: string,
  sortChecked: boolean,
): ReviveEdit | null {
  const plan = planRevive(contents, caretLineIndex, text);
  if (!plan) return null;
  const unsorted = {
    remove: plan.remove,
    revive: plan.uncheck,
    caret: plan.caret,
  };
  if (!sortChecked) return unsorted;

  const uncheck = new Delta(plan.uncheck.ops as never);
  const afterUncheck = new Delta(contents.ops as never)
    .compose(new Delta(plan.remove.ops as never))
    .compose(uncheck);
  const revivedLine = findLineIndexAtPosition(
    deltaToLines(afterUncheck.ops as QuillOp[]),
    plan.caret,
  );
  const sort = planChecklistSort({ ops: afterUncheck.ops as QuillOp[] }, [
    revivedLine,
  ]);
  if (!sort) return unsorted;

  const sortDelta = new Delta(sort.delta.ops as never);
  const sortedLines = deltaToLines(
    afterUncheck.compose(sortDelta).ops as QuillOp[],
  );
  const at = sort.origins.indexOf(revivedLine);
  return {
    remove: plan.remove,
    revive: { ops: uncheck.compose(sortDelta).ops as QuillOp[] },
    caret:
      getLineStartPosition(sortedLines, at) +
      getLineLength(sortedLines[at]) -
      1,
  };
}
