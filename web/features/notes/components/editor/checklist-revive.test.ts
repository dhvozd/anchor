import Delta from "quill-delta";
import { describe, expect, it } from "vitest";
import type { QuillDelta, QuillOp } from "../../quill";
import { didChangeChecklistItemState } from "../../quill-checklist";
import { planReviveEdit, type ReviveEdit } from "./checklist-revive";

type Line = [text: string, list: string | null, indent?: number];

const doc = (lines: Line[]): QuillDelta => {
  const ops: QuillOp[] = [];
  for (const [text, list, indent] of lines) {
    if (text) ops.push({ insert: text });
    const attributes = {
      ...(list ? { list } : {}),
      ...(indent ? { indent } : {}),
    };
    ops.push(
      Object.keys(attributes).length
        ? { insert: "\n", attributes }
        : { insert: "\n" },
    );
  }
  return { ops };
};

const normalized = (ops: QuillOp[]) =>
  new Delta().compose(new Delta(ops as never)).ops;

/** [contents] after the edit's two steps, in the order the menu applies them. */
const applied = (contents: QuillDelta, edit: ReviveEdit) =>
  new Delta(contents.ops as never)
    .compose(new Delta(edit.remove.ops as never))
    .compose(new Delta(edit.revive.ops as never));

function expectEdit(
  contents: QuillDelta,
  edit: ReviveEdit | null,
  expected: Line[],
  caret: number,
): ReviveEdit {
  if (!edit) throw new Error("expected an edit");
  expect(normalized(applied(contents, edit).ops as QuillOp[])).toEqual(
    normalized(doc(expected).ops),
  );
  expect(edit.caret).toBe(caret);
  return edit;
}

/** A document's text, an embed counting as one character. */
const textOf = (delta: Delta) =>
  delta.ops
    .map((op) => (typeof op.insert === "string" ? op.insert : "￼"))
    .join("");

describe("planReviveEdit", () => {
  it("moves the revived item up to the open ones", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["mi", "unchecked"],
      ["Eggs", "checked"],
      ["Milk", "checked"],
    ]);
    expectEdit(
      before,
      planReviveEdit(before, 1, "Milk", true),
      [
        ["Bread", "unchecked"],
        ["Milk", "unchecked"],
        ["Eggs", "checked"],
      ],
      10,
    );
  });

  it("only unchecks the item when sorting is off", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["mi", "unchecked"],
      ["Eggs", "checked"],
      ["Milk", "checked"],
    ]);
    const edit = expectEdit(
      before,
      planReviveEdit(before, 1, "Milk", false),
      [
        ["Bread", "unchecked"],
        ["Eggs", "checked"],
        ["Milk", "unchecked"],
      ],
      15,
    );
    expect(didChangeChecklistItemState(edit.revive)).toBe(true);
  });

  it("only unchecks the item when it is already in place", () => {
    const before = doc([
      ["mi", "unchecked"],
      ["Milk", "checked"],
      ["Eggs", "checked"],
    ]);
    const edit = expectEdit(
      before,
      planReviveEdit(before, 0, "Milk", true),
      [
        ["Milk", "unchecked"],
        ["Eggs", "checked"],
      ],
      4,
    );
    expect(didChangeChecklistItemState(edit.revive)).toBe(true);
  });

  it("moves the item when the typed line was the last line", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["Eggs", "checked"],
      ["Milk", "checked"],
      ["mi", "unchecked"],
    ]);
    expectEdit(
      before,
      planReviveEdit(before, 3, "Milk", true),
      [
        ["Bread", "unchecked"],
        ["Milk", "unchecked"],
        ["Eggs", "checked"],
      ],
      10,
    );
  });

  it("leaves a revived parent in place with its checked sub-item", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["li", "unchecked"],
      ["Lidl", "checked"],
      ["Milk", "checked", 1],
      ["Eggs", "checked"],
    ]);
    expectEdit(
      before,
      planReviveEdit(before, 1, "Lidl", true),
      [
        ["Bread", "unchecked"],
        ["Lidl", "unchecked"],
        ["Milk", "checked", 1],
        ["Eggs", "checked"],
      ],
      10,
    );
  });

  it("takes a revived parent's sub-items along", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["li", "unchecked"],
      ["Eggs", "checked"],
      ["Lidl", "checked"],
      ["Milk", "checked", 1],
    ]);
    expectEdit(
      before,
      planReviveEdit(before, 1, "Lidl", true),
      [
        ["Bread", "unchecked"],
        ["Lidl", "unchecked"],
        ["Milk", "checked", 1],
        ["Eggs", "checked"],
      ],
      10,
    );
  });

  it("revives and sorts in one delta, caret at the item's line end", () => {
    const before = doc([
      ["Bread", "unchecked"],
      ["mi", "unchecked"],
      ["Eggs", "checked"],
      ["Tea", "checked"],
      ["Milk", "checked"],
    ]);
    const edit = expectEdit(
      before,
      planReviveEdit(before, 1, "Milk", true),
      [
        ["Bread", "unchecked"],
        ["Milk", "unchecked"],
        ["Eggs", "checked"],
        ["Tea", "checked"],
      ],
      10,
    );
    expect(Array.isArray(edit.revive.ops)).toBe(true);
    // Not a pure checkbox flip, so the sorter does not sort it again later.
    expect(didChangeChecklistItemState(edit.revive)).toBe(false);
    const text = textOf(applied(before, edit));
    expect(text[edit.caret]).toBe("\n");
    expect(text.slice(edit.caret - 4, edit.caret)).toBe("Milk");
  });

  it("is null when the item is no longer checked", () =>
    expect(
      planReviveEdit(
        doc([
          ["Milk", "unchecked"],
          ["mi", "unchecked"],
        ]),
        1,
        "Milk",
        true,
      ),
    ).toBeNull());

  it("is null when the item is gone", () =>
    expect(
      planReviveEdit(
        doc([
          ["Bread", "checked"],
          ["mi", "unchecked"],
        ]),
        1,
        "Milk",
        true,
      ),
    ).toBeNull());
});
