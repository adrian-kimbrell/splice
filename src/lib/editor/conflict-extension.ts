/**
 * CodeMirror extension for inline merge conflict resolution.
 *
 * Detects <<<<<<<, =======, >>>>>>> markers and adds:
 * - Colored line decorations for "ours" and "theirs" sections
 * - Widget decorations with Accept Current / Incoming / Both buttons
 */

import { EditorView, Decoration, WidgetType, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate, DecorationSet } from "@codemirror/view";

// Conflict region parsed from markers
interface ConflictRegion {
  /** Line number of <<<<<<< */
  oursStart: number;
  /** Line number of ======= */
  separator: number;
  /** Line number of >>>>>>> */
  theirsEnd: number;
}

function findConflicts(doc: { lines: number; line(n: number): { text: string; from: number; to: number } }): ConflictRegion[] {
  const conflicts: ConflictRegion[] = [];
  let oursStart: number | null = null;
  let separator: number | null = null;

  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (text.startsWith("<<<<<<<")) {
      oursStart = i;
      separator = null;
    } else if (text.startsWith("=======") && oursStart !== null) {
      separator = i;
    } else if (text.startsWith(">>>>>>>") && oursStart !== null && separator !== null) {
      conflicts.push({ oursStart, separator, theirsEnd: i });
      oursStart = null;
      separator = null;
    }
  }
  return conflicts;
}

class ConflictButtonWidget extends WidgetType {
  constructor(private conflict: ConflictRegion, private view: EditorView) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "conflict-actions";
    wrapper.style.cssText = "padding: 2px 8px; display: flex; gap: 8px; font-size: 11px; background: var(--bg-sidebar); border-bottom: 1px solid var(--border);";

    const makeBtn = (label: string, action: () => void) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = "cursor: pointer; color: var(--accent); background: none; border: none; font-size: 11px; padding: 0; text-decoration: underline;";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        action();
      });
      return btn;
    };

    wrapper.appendChild(makeBtn("Accept Current", () => this.resolve("current")));
    wrapper.appendChild(document.createTextNode(" | "));
    wrapper.appendChild(makeBtn("Accept Incoming", () => this.resolve("incoming")));
    wrapper.appendChild(document.createTextNode(" | "));
    wrapper.appendChild(makeBtn("Accept Both", () => this.resolve("both")));

    return wrapper;
  }

  private resolve(choice: "current" | "incoming" | "both") {
    const doc = this.view.state.doc;
    const { oursStart, separator, theirsEnd } = this.conflict;

    const oursContentStart = doc.line(oursStart).to + 1;
    const oursContentEnd = doc.line(separator).from;
    const theirsContentStart = doc.line(separator).to + 1;
    const theirsContentEnd = doc.line(theirsEnd).from;

    const oursContent = oursContentEnd > oursContentStart
      ? doc.sliceString(oursContentStart, oursContentEnd)
      : "";
    const theirsContent = theirsContentEnd > theirsContentStart
      ? doc.sliceString(theirsContentStart, theirsContentEnd)
      : "";

    let replacement: string;
    switch (choice) {
      case "current":
        replacement = oursContent;
        break;
      case "incoming":
        replacement = theirsContent;
        break;
      case "both":
        replacement = oursContent + (oursContent && theirsContent ? "\n" : "") + theirsContent;
        break;
    }

    // Replace the entire conflict block (including markers)
    const from = doc.line(oursStart).from;
    const to = doc.line(theirsEnd).to;
    this.view.dispatch({
      changes: { from, to, insert: replacement },
    });
  }
}

const oursLineDecoration = Decoration.line({ class: "conflict-ours" });
const theirsLineDecoration = Decoration.line({ class: "conflict-theirs" });
const markerLineDecoration = Decoration.line({ class: "conflict-marker" });

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const conflicts = findConflicts(doc);
  if (conflicts.length === 0) return Decoration.none;

  const decorations: { from: number; to: number; value: Decoration }[] = [];

  for (const conflict of conflicts) {
    // Button widget above the conflict
    decorations.push({
      from: doc.line(conflict.oursStart).from,
      to: doc.line(conflict.oursStart).from,
      value: Decoration.widget({
        widget: new ConflictButtonWidget(conflict, view),
        side: -1,
      }),
    });

    // Marker lines
    decorations.push({
      from: doc.line(conflict.oursStart).from,
      to: doc.line(conflict.oursStart).from,
      value: markerLineDecoration,
    });
    decorations.push({
      from: doc.line(conflict.separator).from,
      to: doc.line(conflict.separator).from,
      value: markerLineDecoration,
    });
    decorations.push({
      from: doc.line(conflict.theirsEnd).from,
      to: doc.line(conflict.theirsEnd).from,
      value: markerLineDecoration,
    });

    // "Ours" section highlighting
    for (let i = conflict.oursStart + 1; i < conflict.separator; i++) {
      decorations.push({
        from: doc.line(i).from,
        to: doc.line(i).from,
        value: oursLineDecoration,
      });
    }

    // "Theirs" section highlighting
    for (let i = conflict.separator + 1; i < conflict.theirsEnd; i++) {
      decorations.push({
        from: doc.line(i).from,
        to: doc.line(i).from,
        value: theirsLineDecoration,
      });
    }
  }

  // Sort by position for RangeSet
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations.map(d => d.value.range(d.from, d.to)));
}

export const conflictExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export const conflictTheme = EditorView.baseTheme({
  ".conflict-ours": {
    backgroundColor: "rgba(0, 255, 136, 0.08)",
  },
  ".conflict-theirs": {
    backgroundColor: "rgba(97, 175, 239, 0.08)",
  },
  ".conflict-marker": {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    color: "var(--text-dim) !important",
  },
});
