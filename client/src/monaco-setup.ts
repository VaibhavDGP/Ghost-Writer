import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

// The current workspace edits C++ only.
const environment = globalThis as typeof globalThis & {
  MonacoEnvironment?: monaco.Environment;
};

environment.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });