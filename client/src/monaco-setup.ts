import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

const environment = globalThis as typeof globalThis & {
  MonacoEnvironment?: monaco.Environment;
};

environment.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

monaco.editor.defineTheme("ghost-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7E99AD" },
    { token: "keyword", foreground: "A9CDFC" },
    { token: "number", foreground: "EBC994" },
    { token: "string", foreground: "A7DEC4" },
    { token: "type.identifier", foreground: "9FE1EB" },
    { token: "delimiter", foreground: "BACDDD" },
  ],
  colors: {
    "editor.background": "#0F1B2B",
    "editor.foreground": "#D9E7F2",
    "editorGutter.background": "#0F1B2B",
    "editorLineNumber.foreground": "#617F97",
    "editorLineNumber.activeForeground": "#BED7E8",
    "editorCursor.foreground": "#ACE3EF",
    "editor.selectionBackground": "#315471",
    "editor.inactiveSelectionBackground": "#263F56",
    "editor.lineHighlightBackground": "#18293C",
    "editorIndentGuide.background1": "#263C50",
    "editorIndentGuide.activeBackground1": "#53768F",
    "editorWidget.background": "#17283B",
    "editorWidget.border": "#3B5870",
    "editorSuggestWidget.background": "#17283B",
    "editorSuggestWidget.border": "#3B5870",
    "editorSuggestWidget.selectedBackground": "#2B4963",
    "scrollbarSlider.background": "#66869B44",
    "scrollbarSlider.hoverBackground": "#66869B77",
    "scrollbarSlider.activeBackground": "#66869BAA",
  },
});

monaco.editor.defineTheme("ghost-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "667F91" },
    { token: "keyword", foreground: "335CA1" },
    { token: "number", foreground: "986522" },
    { token: "string", foreground: "2D7659" },
    { token: "type.identifier", foreground: "286E85" },
    { token: "delimiter", foreground: "41596F" },
  ],
  colors: {
    "editor.background": "#F4F8FB",
    "editor.foreground": "#20394D",
    "editorGutter.background": "#F4F8FB",
    "editorLineNumber.foreground": "#8CA2B3",
    "editorLineNumber.activeForeground": "#385F7B",
    "editorCursor.foreground": "#2B6387",
    "editor.selectionBackground": "#BDD8EC",
    "editor.inactiveSelectionBackground": "#DBE8F1",
    "editor.lineHighlightBackground": "#E7F0F6",
    "editorIndentGuide.background1": "#D2DFE8",
    "editorIndentGuide.activeBackground1": "#9DB7C9",
    "editorWidget.background": "#EDF4F9",
    "editorWidget.border": "#9DB7C9",
    "editorSuggestWidget.background": "#EDF4F9",
    "editorSuggestWidget.border": "#9DB7C9",
    "editorSuggestWidget.selectedBackground": "#C9DFEF",
    "scrollbarSlider.background": "#678AA544",
    "scrollbarSlider.hoverBackground": "#678AA577",
    "scrollbarSlider.activeBackground": "#678AA5AA",
  },
});

loader.config({ monaco });