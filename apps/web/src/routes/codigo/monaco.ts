import { useEffect, useState } from "react";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Monaco —el editor de VS Code— empaquetado con la app.
 *
 * `@monaco-editor/react` por default lo baja de un CDN, y un IDE que deja de
 * abrir archivos cuando no hay red (o cuando jsdelivr tarda) no es un IDE. Se
 * le pasa la instancia local y los workers los arma Vite.
 *
 * Los diagnósticos semánticos de JS/TS van apagados a propósito: el editor no
 * tiene el proyecto entero cargado, así que cada import sin resolver sería un
 * subrayado rojo falso. La verificación de verdad es `npm test`/`tsc` en la
 * terminal; acá quedan la sintaxis, el resaltado y el autocompletado.
 */

self.MonacoEnvironment = {
  getWorker(_id, etiqueta) {
    if (etiqueta === "json") return new JsonWorker();
    if (etiqueta === "css" || etiqueta === "scss" || etiqueta === "less") return new CssWorker();
    if (etiqueta === "html" || etiqueta === "handlebars" || etiqueta === "razor") return new HtmlWorker();
    if (etiqueta === "typescript" || etiqueta === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

// Monaco cancela sus tareas pendientes al cerrar un editor (el resaltado de
// palabras, por ejemplo) y la cancelación sale como una promesa rechazada sin
// dueño: "Canceled: Canceled" en la consola cada vez que se cierra una pestaña.
// No es un error, pero ensucia la consola hasta tapar los que sí lo son. Se
// silencia sólo esa, por nombre y mensaje exactos.
window.addEventListener("unhandledrejection", (evento) => {
  const razon = evento.reason as { name?: unknown; message?: unknown } | null;
  if (razon?.name === "Canceled" && razon.message === "Canceled") evento.preventDefault();
});

const sinDiagnosticosFalsos = { noSemanticValidation: true, noSyntaxValidation: false };
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(sinDiagnosticosFalsos);
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(sinDiagnosticosFalsos);
const compilador = {
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  allowNonTsExtensions: true,
};
monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilador);
monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilador);

/**
 * Los temas usan los mismos colores de fondo que la app (los `--t-*` de
 * styles.css pasados a hex): con el `vs-dark` puro el editor quedaba como una
 * ventana de otra aplicación pegada en el medio.
 */
monaco.editor.defineTheme("orq-oscuro", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#16181d",
    "editorGutter.background": "#16181d",
    "minimap.background": "#16181d",
    "editor.lineHighlightBackground": "#1f2229",
    "editorLineNumber.foreground": "#5b606b",
    "editorLineNumber.activeForeground": "#c7cad1",
    "editorWidget.background": "#1d2026",
    "diffEditor.insertedTextBackground": "#2ea04326",
    "diffEditor.removedTextBackground": "#f8514926",
  },
});
monaco.editor.defineTheme("orq-claro", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#fdfdfe",
    "editorGutter.background": "#fdfdfe",
    "minimap.background": "#fdfdfe",
    "editor.lineHighlightBackground": "#f1f3f6",
    "editorLineNumber.foreground": "#9aa0aa",
  },
});

function temaActual(): "orq-oscuro" | "orq-claro" {
  const elegido = document.documentElement.dataset.theme;
  if (elegido === "dark") return "orq-oscuro";
  if (elegido === "light") return "orq-claro";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "orq-oscuro" : "orq-claro";
}

/** El tema del editor sigue al de la app, también cuando cambia en vivo. */
export function useTemaMonaco(): "orq-oscuro" | "orq-claro" {
  const [tema, setTema] = useState(temaActual);
  useEffect(() => {
    const actualizar = () => setTema(temaActual());
    const observador = new MutationObserver(actualizar);
    observador.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", actualizar);
    return () => {
      observador.disconnect();
      media.removeEventListener("change", actualizar);
    };
  }, []);
  return tema;
}

const LENGUAJES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp",
  php: "php", rb: "ruby", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", xml: "xml", svg: "xml", sql: "sql", glsl: "cpp", frag: "cpp", vert: "cpp",
  dockerfile: "dockerfile", graphql: "graphql", vue: "html", svelte: "html",
};

export function lenguajeDe(ruta: string): string {
  const nombre = ruta.split("/").at(-1)?.toLowerCase() ?? "";
  if (nombre === "dockerfile") return "dockerfile";
  if (nombre === "makefile") return "makefile";
  const ext = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1) : "";
  return LENGUAJES[ext] ?? "plaintext";
}

/** Nombre legible del lenguaje, para la barra de estado. */
export function etiquetaDeLenguaje(id: string): string {
  const etiquetas: Record<string, string> = {
    javascript: "JavaScript", typescript: "TypeScript", json: "JSON", markdown: "Markdown",
    html: "HTML", css: "CSS", python: "Python", go: "Go", rust: "Rust", plaintext: "Texto sin formato",
    shell: "Shell", yaml: "YAML", cpp: "C++", c: "C",
  };
  return etiquetas[id] ?? id;
}

export { monaco };
