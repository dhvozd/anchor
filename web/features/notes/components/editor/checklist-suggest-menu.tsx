"use client";

import * as React from "react";
import { menuItem, menuSurface } from "@/components/ui/dropdown-menu";
import { ShortcutHints } from "@/components/ui/shortcut-hints";
import { isPhoneWidth } from "@/lib/hooks/use-is-phone";
import { cn } from "@/lib/utils";
import {
  type ChecklistSuggestion,
  findChecklistSuggestions,
  matchedRanges,
  planRevive,
} from "../../checklist-suggest";
import {
  LIST_FORMATS,
  type QuillDelta,
  type QuillInstance,
  type QuillLine,
} from "../../quill";
import { deltaToLines, findLineIndexAtPosition } from "../../quill-lines";
import { isSlashMenuOpen } from "./slash-menu";

/** The text before the caret while the `/` menu is active. */
const SLASH_COMMAND = /(^|\s)\/\S*$/;

interface Place {
  top: number;
  left: number;
  height: number;
}

interface Menu {
  items: ChecklistSuggestion[];
  place: Place;
  /** The caret line's text. */
  query: string;
}

interface ChecklistSuggestMenuProps {
  getQuill: () => QuillInstance | null;
  container: HTMLElement | null;
}

/**
 * The line a user edit typed text into, when the whole edit stays on that
 * line. Edits across lines, such as a checklist sort, are not typing.
 */
function typedLineOf(
  quill: QuillInstance,
  delta: QuillDelta,
): QuillLine | null {
  let position = 0;
  let from = -1;
  let to = -1;
  let hasText = false;
  for (const op of delta.ops) {
    if (op.retain && !op.attributes) {
      position += op.retain;
      continue;
    }
    if (from < 0) from = position;
    if (typeof op.insert === "string") {
      hasText = true;
      position += op.insert.length;
    } else if (op.insert !== undefined) position += 1;
    else position += op.retain ?? 0;
    to = position;
  }
  if (!hasText) return null;
  const [line, offset] = quill.getLine(from);
  return line && to < from - offset + line.length() ? line : null;
}

/** [text] with the parts that match [query] in bold. */
function emphasise(text: string, query: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of matchedRanges(text, query)) {
    parts.push(
      text.slice(at, start),
      <span key={start} className="font-semibold">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  parts.push(text.slice(at));
  return parts;
}

export function ChecklistSuggestMenu({
  getQuill,
  container,
}: ChecklistSuggestMenuProps) {
  const [menu, setMenu] = React.useState<Menu | null>(null);
  const [active, setActive] = React.useState(-1);
  const [above, setAbove] = React.useState(false);
  /** The list only shows on the line the user last typed on. */
  const typedLine = React.useRef<QuillLine | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const isOpen = menu !== null;

  const hide = React.useCallback(() => {
    setMenu(null);
    setActive(-1);
  }, []);

  const close = React.useCallback(() => {
    typedLine.current = null;
    hide();
  }, [hide]);

  const placeAt = React.useCallback(
    (quill: QuillInstance, index: number, length: number): Place | null => {
      if (!container) return null;
      const bounds = quill.getBounds(index, length);
      if (!bounds) return null;
      const box = container.getBoundingClientRect();
      const editorBox = quill.container.getBoundingClientRect();
      return {
        top: editorBox.top - box.top + bounds.top,
        left: editorBox.left - box.left + bounds.left,
        height: bounds.height,
      };
    },
    [container],
  );

  React.useEffect(() => {
    if (!container) return;
    let quill: QuillInstance | null = null;

    const update = (typed: QuillLine | null) => {
      if (!quill) return;
      const selection = quill.getSelection();
      if (!selection || selection.length) {
        close();
        return;
      }
      const [line, offset] = quill.getLine(selection.index);
      if (line && line === typed) typedLine.current = line;
      else if (typedLine.current !== line) typedLine.current = null;
      if (!line || typedLine.current !== line) {
        hide();
        return;
      }
      const start = selection.index - offset;
      if (
        line.formats().list !== LIST_FORMATS.UNCHECKED ||
        SLASH_COMMAND.test(quill.getText(start, offset)) ||
        isSlashMenuOpen(quill.root)
      ) {
        hide();
        return;
      }
      const contents = quill.getContents();
      const items = findChecklistSuggestions(
        contents,
        findLineIndexAtPosition(deltaToLines(contents.ops), selection.index),
      );
      // Under the whole line, which may wrap.
      const place = items.length
        ? placeAt(quill, start, line.length() - 1)
        : null;
      if (place)
        setMenu({
          items,
          place,
          query: quill.getText(start, line.length() - 1),
        });
      else hide();
    };

    const onChange = (name: string, ...args: unknown[]) => {
      if (name === "text-change") {
        const [delta, , source] = args as [QuillDelta, unknown, string];
        // Undo and redo replay edits; they are not typing.
        const typed =
          quill && source === "user" && !quill.history.ignoreChange
            ? typedLineOf(quill, delta)
            : null;
        setActive(-1);
        // Quill settles the selection after the change.
        queueMicrotask(() => update(typed));
      } else update(null);
    };

    // Quill keeps its selection while focus is elsewhere.
    const onFocusOut = (e: FocusEvent) => {
      if (quill && e.target === quill.root) close();
    };

    // Quill is rebuilt under the same box in strict mode; follow the current one.
    const attach = () => {
      const next = getQuill();
      if (next === quill) return;
      quill?.off("editor-change", onChange);
      quill?.off("composition-start", hide);
      quill = next;
      quill?.on("editor-change", onChange);
      // Quill holds back changes while composing, so the list would go stale;
      // the change after the composition brings it back.
      quill?.on("composition-start", hide);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      container.removeEventListener("focusout", onFocusOut);
      quill?.off("editor-change", onChange);
      quill?.off("composition-start", hide);
    };
  }, [container, getQuill, placeAt, hide, close]);

  const pick = React.useCallback(
    (item: ChecklistSuggestion) => {
      const quill = getQuill();
      // Deleting the line being composed leaves the composed text adrift.
      if (quill?.composition.isComposing) return;
      close();
      const selection = quill?.getSelection();
      if (!quill || !selection) return;
      const contents = quill.getContents();
      const plan = planRevive(
        contents,
        findLineIndexAtPosition(deltaToLines(contents.ops), selection.index),
        item.text,
      );
      if (!plan) return;
      // One undo step brings back the typed line and the crossed-off item.
      quill.history.cutoff();
      quill.updateContents(plan.remove, "user");
      quill.updateContents(plan.uncheck, "user");
      quill.setSelection(plan.caret, 0, "user");
      quill.history.cutoff();
    },
    [getQuill, close],
  );

  // Keys go to the list before the editor sees them; nothing else is taken.
  React.useEffect(() => {
    if (!container || !menu) return;
    const { items } = menu;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.isComposing ||
        e.defaultPrevented ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey
      )
        return;
      const item = items[active];
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown")
        setActive((prev) => (prev + 1) % items.length);
      else if (e.key === "ArrowUp")
        setActive(
          (prev) =>
            (prev > 0 ? Math.min(prev, items.length) : items.length) - 1,
        );
      else if (e.key === "Enter" && item) pick(item);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener("keydown", onKey, true);
    return () => container.removeEventListener("keydown", onKey, true);
  }, [container, menu, active, pick, close]);

  React.useEffect(() => {
    const root = getQuill()?.root;
    if (!root || !isOpen || active < 0) return;
    const id = `${listId}-${active}`;
    root.setAttribute("aria-activedescendant", id);
    return () => {
      if (root.getAttribute("aria-activedescendant") === id)
        root.removeAttribute("aria-activedescendant");
    };
  }, [isOpen, active, listId, getQuill]);

  React.useLayoutEffect(() => {
    if (!menu || !menuRef.current || !container) return;
    const menuHeight = menuRef.current.offsetHeight + 14;
    const lineTop = container.getBoundingClientRect().top + menu.place.top;
    const toolbarHeight = isPhoneWidth() ? 64 : 0;
    setAbove(
      window.innerHeight - toolbarHeight - (lineTop + menu.place.height) <
        menuHeight && lineTop > menuHeight,
    );
  }, [menu, container]);

  if (!menu) return null;
  const { items, place, query } = menu;

  return (
    <div
      ref={menuRef}
      className={cn(
        menuSurface,
        "absolute z-(--z-float) grid grid-cols-1 w-62.5 max-w-[calc(100%-8px)] gap-px rounded-menu p-1.5 animate-pop-in",
      )}
      style={
        above
          ? { bottom: `calc(100% - ${place.top}px + 6px)`, left: place.left }
          : { top: place.top + place.height + 6, left: place.left }
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        role="listbox"
        id={listId}
        aria-label="Restore a checked item"
        className="grid min-w-0 grid-cols-1 gap-px"
      >
        {items.map((item, i) => (
          <div
            key={item.lineIndex}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            data-kbd={i === active || undefined}
            data-highlighted={i === active ? "" : undefined}
            onClick={() => pick(item)}
            className={cn(
              menuItem,
              "whitespace-normal hover:bg-foreground/6 data-kbd:after:absolute data-kbd:after:top-1/2 data-kbd:after:left-0.75 data-kbd:after:-mt-2 data-kbd:after:h-4 data-kbd:after:w-0.75 data-kbd:after:rounded-xs data-kbd:after:bg-accent-strong data-kbd:after:content-['']",
            )}
          >
            <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
              {emphasise(item.text, query)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center border-border/55 border-t px-1.5 pt-2 pb-0.5 text-caption text-muted-foreground max-md:hidden">
        <ShortcutHints
          groups={[
            [["↑", "↓"], "move"],
            [["↵"], "restore"],
          ]}
          screenReaderText="Up and down arrows move, Enter restores"
        />
      </div>
    </div>
  );
}
