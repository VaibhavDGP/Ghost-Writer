import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { SharedSnapshot } from "./shared-document";
import "./monaco-setup";

interface Span {
  start: number;
  end: number;
  body: string;
}

interface Layout {
  source: string;
  spans: Record<string, Span>;
}

function layout(snapshot: SharedSnapshot): Layout {
  let source = "";
  const spans: Record<string, Span> = {};

  snapshot.names.forEach((name, index) => {
    source += snapshot.parts[index];

    const start = source.length;
    const body = snapshot.functions[name].body;
    source += body;

    spans[name] = {
      start,
      end: source.length,
      body,
    };
  });

  source += snapshot.parts[snapshot.names.length];

  return { source, spans };
}

interface Props {
  snapshot: SharedSnapshot;
  theme: "light" | "dark";
  editable: boolean;
  onEdit: (name: string, body: string) => void;
  onWarning: (message: string) => void;
}

export default function SharedEditor(props: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const applying = useRef(false);
  const rendered = useRef<Layout | null>(null);
  const latest = useRef(props);
  const lastOwned = useRef<string | null>(null);

  latest.current = props;

  const ownedName = props.snapshot.names.find(
    (name) =>
      props.snapshot.functions[name].ownerId === props.snapshot.playerId,
  ) ?? null;

  useEffect(() => {
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return;

    const next = layout(props.snapshot);
    const previous = rendered.current;

    if (!previous) {
      applying.current = true;
      model.setValue(next.source);
      applying.current = false;
      rendered.current = next;
    } else if (previous.source !== next.source) {
      const edits = props.snapshot.names.flatMap((name) => {
        const before = previous.spans[name];
        const after = next.spans[name];

        if (!before || before.body === after.body) return [];

        return [{
          start: before.start,
          end: before.end,
          text: after.body,
        }];
      });

      const positions = instance.getSelections()?.map((selection) => ({
        anchor: model.getOffsetAt({
          lineNumber: selection.selectionStartLineNumber,
          column: selection.selectionStartColumn,
        }),
        active: model.getOffsetAt({
          lineNumber: selection.positionLineNumber,
          column: selection.positionColumn,
        }),
      })) ?? [];

      const scrollTop = instance.getScrollTop();
      const scrollLeft = instance.getScrollLeft();

      const translate = (offset: number) => {
        let difference = 0;

        for (const edit of edits) {
          if (offset <= edit.start) break;

          if (offset >= edit.end) {
            difference += edit.text.length - (edit.end - edit.start);
          } else {
            return edit.start + difference +
              Math.min(offset - edit.start, edit.text.length);
          }
        }

        return offset + difference;
      };

      applying.current = true;

      try {
        model.applyEdits(edits.map((edit) => {
          const start = model.getPositionAt(edit.start);
          const end = model.getPositionAt(edit.end);

          return {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: edit.text,
            forceMoveMarkers: true,
          };
        }));

        instance.setSelections(positions.map((position) => {
          const anchor = model.getPositionAt(translate(position.anchor));
          const active = model.getPositionAt(translate(position.active));

          return {
            selectionStartLineNumber: anchor.lineNumber,
            selectionStartColumn: anchor.column,
            positionLineNumber: active.lineNumber,
            positionColumn: active.column,
          };
        }));

        instance.setScrollPosition({ scrollTop, scrollLeft });
        rendered.current = next;
      } finally {
        applying.current = false;
      }
    }

    instance.updateOptions({ readOnly: !props.editable });

    if (ownedName && ownedName !== lastOwned.current) {
      const span = next.spans[ownedName];
      const position = model.getPositionAt(span.start);

      instance.setPosition(position);
      instance.revealLineInCenter(position.lineNumber);
      instance.focus();
    }

    lastOwned.current = ownedName;
  }, [props.snapshot, props.editable, ownedName]);

  function changed(value: string | undefined) {
    if (applying.current || value === undefined) return;

    const current = latest.current;
    const previous = rendered.current;
    const instance = editorRef.current;
    const model = instance?.getModel();

    if (!previous || !instance || !model) return;

    const name = current.snapshot.names.find(
      (item) =>
        current.snapshot.functions[item].ownerId ===
        current.snapshot.playerId,
    );

    const span = name ? previous.spans[name] : null;

    const prefix = span ? previous.source.slice(0, span.start) : "";
    const suffix = span ? previous.source.slice(span.end) : "";

    const allowed =
      current.editable &&
      name &&
      span &&
      value.length >= prefix.length + suffix.length &&
      value.startsWith(prefix) &&
      value.endsWith(suffix);

    if (!allowed || !name || !span) {
      applying.current = true;

      try {
        model.applyEdits([{
          range: model.getFullModelRange(),
          text: previous.source,
        }]);
      } finally {
        applying.current = false;
      }

      current.onWarning(
        "Edit only inside your claimed function. Other functions, " +
          "signatures, outer braces and main() are protected.",
      );
      return;
    }

    const body = value.slice(prefix.length, value.length - suffix.length);

    rendered.current = layout({
      ...current.snapshot,
      functions: {
        ...current.snapshot.functions,
        [name]: {
          ...current.snapshot.functions[name],
          body,
        },
      },
    });

    current.onEdit(name, body);
  }

  return (
    <Editor
      height="100%"
      language="cpp"
      theme={props.theme === "dark" ? "vs-dark" : "light"}
      path={`file:///ghost-writer/shared/${props.snapshot.matchId}/main.cpp`}
      defaultValue={layout(props.snapshot).source}
      onMount={(instance) => {
        editorRef.current = instance;
        const initial = layout(latest.current.snapshot);
        rendered.current = initial;

        applying.current = true;
        instance.getModel()?.setValue(initial.source);
        instance.updateOptions({
          readOnly: !latest.current.editable,
        });
        applying.current = false;
      }}
      onChange={changed}
      options={{
        automaticLayout: true,
        readOnly: !props.editable,
        fontSize: 14,
        lineHeight: 22,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        wordWrap: "on",
        padding: { top: 16, bottom: 16 },
        ariaLabel: "Shared C++ document",
      }}
    />
  );
}