import Delta from "quill-delta";
import { describe, expect, it } from "vitest";
import {
  findChecklistSuggestions,
  matchedRanges,
  planRevive,
  type RevivePlan,
} from "./checklist-suggest";
import type { QuillDelta, QuillOp } from "./quill";
import { didChangeChecklistItemState } from "./quill-checklist";

function doc(lines: [string, string | null, number?][]): QuillDelta {
  const ops: QuillOp[] = [];
  for (const [text, list, indent] of lines) {
    if (text) ops.push({ insert: text });
    const attributes = {
      ...(list ? { list } : {}),
      ...(indent ? { indent } : {}),
    };
    ops.push({
      insert: "\n",
      ...(Object.keys(attributes).length ? { attributes } : {}),
    });
  }
  return { ops };
}

/** Merge adjacent ops so deltas compare by content, attributes included. */
function normalized(delta: QuillDelta): QuillOp[] {
  const result = new Delta();
  for (const op of delta.ops) {
    result.push(op as never);
  }
  return result.ops as QuillOp[];
}

/** Apply [plan] to [contents] and compare the whole result against [expected]. */
function expectRevived(
  contents: QuillDelta,
  plan: RevivePlan,
  expected: [string, string | null, number?][],
) {
  const result = new Delta(contents.ops as never)
    .compose(new Delta(plan.remove.ops as never))
    .compose(new Delta(plan.uncheck.ops as never));
  expect(normalized({ ops: result.ops as QuillOp[] })).toEqual(
    normalized(doc(expected)),
  );
}

const s = (contents: QuillDelta, caret: number) =>
  findChecklistSuggestions(contents, caret).map((x) => x.text);

describe("stray combining marks", () => {
  it("does not suggest from an emoji variation selector alone", () => {
    expect(
      s(
        doc([
          ["❤️ Milk", "checked"],
          ["☕️", "unchecked"],
        ]),
        1,
      ),
    ).toEqual([]);
  });

  it("still matches words next to a marked emoji", () => {
    expect(
      s(
        doc([
          ["Almond milk", "checked"],
          ["❤️ Milk", "checked"],
          ["mil", "unchecked"],
        ]),
        2,
      ),
    ).toEqual(["❤️ Milk", "Almond milk"]);
  });
});

describe("findChecklistSuggestions", () => {
  it("suggests a checked item by prefix", () =>
    expect(
      s(
        doc([
          ["Milk (Lidl)", "checked"],
          ["mi", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["Milk (Lidl)"]));

  it("matches the start of any word", () =>
    expect(
      s(
        doc([
          ["Milk (Lidl)", "checked"],
          ["lid", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["Milk (Lidl)"]));

  it("ignores unchecked items", () =>
    expect(
      s(
        doc([
          ["Milk", "unchecked"],
          ["mi", "unchecked"],
        ]),
        1,
      ),
    ).toEqual([]));

  it("needs two characters", () =>
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["m", "unchecked"],
        ]),
        1,
      ),
    ).toEqual([]));

  it("trims the query", () =>
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["mil ", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["Milk"]));

  it("only on an unchecked checklist line", () => {
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["mi", "checked"],
        ]),
        1,
      ),
    ).toEqual([]);
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["mi", null],
        ]),
        1,
      ),
    ).toEqual([]);
  });

  it("is case-insensitive for Cyrillic", () =>
    expect(
      s(
        doc([
          ["Молоко", "checked"],
          ["МОЛ", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["Молоко"]));

  it("matches past an emoji", () =>
    expect(
      s(
        doc([
          ["🥛 Milk", "checked"],
          ["mil", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["🥛 Milk"]));

  it("keeps vowel signs inside a word", () => {
    const hindi = (query: string) =>
      s(
        doc([
          ["दूध", "checked"],
          [query, "unchecked"],
        ]),
        1,
      );
    expect(hindi("दू")).toEqual(["दूध"]);
    expect(hindi("धा")).toEqual([]);
  });

  it("keeps combining accents inside a word", () => {
    const naive = "nai\u0308ve";
    const latin = (query: string) =>
      s(
        doc([
          [naive, "checked"],
          [query, "unchecked"],
        ]),
        1,
      );
    expect(latin("nai\u0308")).toEqual([naive]);
    expect(latin("ve")).toEqual([]);
  });

  it("collapses duplicates to the first", () => {
    const r = findChecklistSuggestions(
      doc([
        ["Milk", "checked"],
        ["Bread", "checked"],
        ["milk  ", "checked"],
        ["mi", "unchecked"],
      ]),
      3,
    );
    expect(r).toEqual([{ lineIndex: 0, text: "Milk" }]);
  });

  it("ranks a full prefix before a word match", () =>
    expect(
      s(
        doc([
          ["Almond milk", "checked"],
          ["Milk", "checked"],
          ["mil", "unchecked"],
        ]),
        2,
      ),
    ).toEqual(["Milk", "Almond milk"]));

  it("needs every query word", () => {
    expect(
      s(
        doc([
          ["Milk (Lidl)", "checked"],
          ["mi li", "unchecked"],
        ]),
        1,
      ),
    ).toEqual(["Milk (Lidl)"]);
    expect(
      s(
        doc([
          ["Milk (Lidl)", "checked"],
          ["mi ka", "unchecked"],
        ]),
        1,
      ),
    ).toEqual([]);
  });

  it("returns at most five", () => {
    const rows: [string, string | null][] = [1, 2, 3, 4, 5, 6, 7].map((n) => [
      `Milk ${n}`,
      "checked",
    ]);
    expect(
      findChecklistSuggestions(doc([...rows, ["mi", "unchecked"]]), 7),
    ).toHaveLength(5);
  });

  it("skips a checked item under a checked parent", () => {
    expect(
      s(
        doc([
          ["Lidl", "checked"],
          ["Milk", "checked", 1],
          ["mi", "unchecked"],
        ]),
        2,
      ),
    ).toEqual([]);
    expect(
      s(
        doc([
          ["Lidl", "unchecked"],
          ["Milk", "checked", 1],
          ["mi", "unchecked"],
        ]),
        2,
      ),
    ).toEqual(["Milk"]);
  });

  it("offers nothing on a line with sub-items", () =>
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["mi", "unchecked"],
          ["x", "unchecked", 1],
        ]),
        1,
      ),
    ).toEqual([]));

  it("offers nothing on a line with a link", () => {
    const contents: QuillDelta = {
      ops: [
        { insert: "Milk" },
        { insert: "\n", attributes: { list: "checked" } },
        { insert: "mi", attributes: { link: "https://x.test" } },
        { insert: "\n", attributes: { list: "unchecked" } },
      ],
    };
    expect(s(contents, 1)).toEqual([]);
  });

  it("ranks the caret's own checklist first", () =>
    expect(
      s(
        doc([
          ["Milk A", "checked"],
          ["Kaufland", null],
          ["Milk B", "checked"],
          ["mi", "unchecked"],
        ]),
        3,
      ),
    ).toEqual(["Milk B", "Milk A"]));

  it("offers nothing on a line with an embed", () => {
    const contents: QuillDelta = {
      ops: [
        { insert: "Milk" },
        { insert: "\n", attributes: { list: "checked" } },
        { insert: "mi" },
        { insert: { image: "x.png" } },
        { insert: "\n", attributes: { list: "unchecked" } },
      ],
    };
    expect(s(contents, 1)).toEqual([]);
  });

  it("offers nothing for a query without letters or digits", () =>
    expect(
      s(
        doc([
          ["Milk", "checked"],
          ["--", "unchecked"],
        ]),
        1,
      ),
    ).toEqual([]));
});

describe("planRevive", () => {
  it("removes the typed line and unchecks the item", () => {
    const before = doc([
      ["Milk", "checked"],
      ["mi", "unchecked"],
      ["Eggs", "unchecked"],
    ]);
    const plan = planRevive(before, 1, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Milk", "unchecked"],
      ["Eggs", "unchecked"],
    ]);
    expect(plan.caret).toBe(4);
    expect(didChangeChecklistItemState(plan.uncheck)).toBe(true);
  });

  it("handles the item after the typed line", () => {
    const before = doc([
      ["mi", "unchecked"],
      ["Milk", "checked"],
    ]);
    const plan = planRevive(before, 0, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [["Milk", "unchecked"]]);
    expect(plan.caret).toBe(4);
  });

  it("removes a typed last line without changing the line above", () => {
    const before = doc([
      ["Milk", "checked"],
      ["Bread", "checked"],
      ["mi", "unchecked"],
    ]);
    const plan = planRevive(before, 2, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Milk", "unchecked"],
      ["Bread", "checked"],
    ]);
  });

  it("removes a typed last line right under the item", () => {
    const before = doc([
      ["Milk", "checked"],
      ["mi", "unchecked"],
    ]);
    const plan = planRevive(before, 1, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [["Milk", "unchecked"]]);
    expect(plan.caret).toBe(4);
  });

  it("keeps a plain line above a typed last line plain", () => {
    const before = doc([
      ["Milk", "checked"],
      ["Shop", null],
      ["mi", "unchecked"],
    ]);
    const plan = planRevive(before, 2, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Milk", "unchecked"],
      ["Shop", null],
    ]);
    expect(plan.caret).toBe(4);
  });

  it("keeps a typed last line's indent off the line above", () => {
    const before = doc([
      ["Lidl", "unchecked"],
      ["Milk", "checked", 1],
      ["Bread", "unchecked"],
      ["mi", "unchecked", 1],
    ]);
    const plan = planRevive(before, 3, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Lidl", "unchecked"],
      ["Milk", "unchecked", 1],
      ["Bread", "unchecked"],
    ]);
    expect(plan.caret).toBe(9);
  });

  it("counts an emoji as two units", () => {
    const before = doc([
      ["Milk", "checked"],
      ["🥛 mi", "unchecked"],
      ["Eggs", "unchecked"],
    ]);
    const plan = planRevive(before, 1, "Milk");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Milk", "unchecked"],
      ["Eggs", "unchecked"],
    ]);
  });

  it("unchecks only the parent", () => {
    const before = doc([
      ["Lidl", "checked"],
      ["Milk", "checked", 1],
      ["li", "unchecked"],
    ]);
    const plan = planRevive(before, 2, "Lidl");
    if (!plan) throw new Error("expected a plan");
    expectRevived(before, plan, [
      ["Lidl", "unchecked"],
      ["Milk", "checked", 1],
    ]);
  });

  it("is null when the item is no longer checked", () =>
    expect(
      planRevive(
        doc([
          ["Milk", "unchecked"],
          ["mi", "unchecked"],
        ]),
        1,
        "Milk",
      ),
    ).toBeNull());

  it("is null when the item is gone", () =>
    expect(
      planRevive(
        doc([
          ["Bread", "checked"],
          ["mi", "unchecked"],
        ]),
        1,
        "Milk",
      ),
    ).toBeNull());
});

describe("matchedRanges", () => {
  it("covers the matched start of each word", () =>
    expect(matchedRanges("Milk (Lidl)", "mi li")).toEqual([
      [0, 2],
      [6, 8],
    ]));

  it("sorts and merges overlapping matches", () =>
    expect(matchedRanges("Milk (Lidl)", "li m mil")).toEqual([
      [0, 3],
      [6, 8],
    ]));

  it("is case-insensitive for Cyrillic", () =>
    expect(matchedRanges("Молоко", "мол")).toEqual([[0, 3]]));

  it("counts UTF-16 units", () =>
    expect(matchedRanges("🥛 Milk", "mil")).toEqual([[3, 6]]));

  it("is empty without a match", () =>
    expect(matchedRanges("Milk", "br")).toEqual([]));

  it("ignores a stray variation selector", () =>
    expect(matchedRanges("❤️ Milk", "☕️")).toEqual([]));
});
