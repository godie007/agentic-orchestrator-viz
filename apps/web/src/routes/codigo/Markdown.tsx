import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { lenguajeDe, monaco, useTemaMonaco } from "./monaco.js";

/**
 * Markdown del chat de IA: lo que escribe el agente —y lo que le pedís vos—
 * con negritas, listas, tablas y bloques de código, como en Cursor.
 *
 * Tres decisiones:
 * - **Sin HTML crudo.** `react-markdown` no ejecuta el HTML que venga en el
 *   texto (no se usa `rehype-raw`), y los enlaces `javascript:` los descarta:
 *   este texto lo escribe un agente, que a su vez leyó código de cualquier lado.
 * - **Las rutas del repo son enlaces.** Un agente dice "cambié
 *   `src/shader.js:143`": si esa ruta existe en el repo, click y se abre ahí.
 * - **El código se colorea con Monaco**, el mismo resaltado del editor: dos
 *   resaltadores distintos harían que el mismo archivo se viera de dos maneras.
 */

export function Markdown({
  texto,
  archivos,
  onAbrirArchivo,
  resolverEnlace,
  resolverImagen,
  grande = false,
}: {
  texto: string;
  /** Rutas del repo: las que aparezcan en `código` se vuelven enlaces. */
  archivos?: readonly string[];
  onAbrirArchivo?: (ruta: string, linea?: number) => void;
  /**
   * Un enlace que no es web (`[[Nota]]`, `otra.md`): qué hacer al tocarlo, o
   * `null` si no lleva a ningún lado. Lo usan las notas de Obsidian.
   */
  resolverEnlace?: (href: string) => (() => void) | null;
  /** De dónde sale una imagen relativa (`![](diagrama.png)`), o `null`. */
  resolverImagen?: (src: string) => string | null;
  /** Tipografía de documento, no de chat. */
  grande?: boolean;
}) {
  const existentes = new Set(archivos ?? []);

  const componentes: Components = {
    p: ({ children }) => <p className={`${grande ? "my-3" : "my-1.5"} first:mt-0 last:mb-0`}>{children}</p>,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    h1: ({ children }) =>
      grande ? (
        <h1 className="mt-6 mb-3 border-b border-line pb-2 text-[24px] font-semibold text-ink first:mt-0">{children}</h1>
      ) : (
        <h3 className="mt-3 mb-1 text-[13px] font-semibold text-ink first:mt-0">{children}</h3>
      ),
    h2: ({ children }) =>
      grande ? (
        <h2 className="mt-6 mb-2 text-[19px] font-semibold text-ink first:mt-0">{children}</h2>
      ) : (
        <h3 className="mt-3 mb-1 text-[13px] font-semibold text-ink first:mt-0">{children}</h3>
      ),
    h3: ({ children }) => (
      <h4 className={`${grande ? "mt-4 mb-1.5 text-[16px]" : "mt-2 mb-1 text-[12px]"} font-semibold text-ink first:mt-0`}>{children}</h4>
    ),
    h4: ({ children }) => (
      <h4 className={`${grande ? "mt-3 mb-1 text-[14px]" : "mt-2 mb-1 text-[12px]"} font-semibold text-ink-dim first:mt-0`}>{children}</h4>
    ),
    ul: ({ children, className }) => (
      <ul className={`my-1.5 space-y-0.5 pl-4 ${className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc"}`}>
        {children}
      </ul>
    ),
    ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
    li: ({ children }) => <li className="marker:text-ink-faint">{children}</li>,
    input: ({ checked }) => (
      <input type="checkbox" checked={Boolean(checked)} readOnly className="mr-1.5 translate-y-[1px] accent-[var(--color-accent)]" />
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-accent/50 pl-2.5 text-ink-dim">{children}</blockquote>
    ),
    hr: () => <hr className="my-3 border-line" />,
    img: ({ src, alt }) => {
      const origen = typeof src === "string" ? (/^https?:/i.test(src) ? src : (resolverImagen?.(src) ?? null)) : null;
      return origen ? (
        <img src={origen} alt={alt ?? ""} loading="lazy" className="my-2 max-w-full rounded border border-line" />
      ) : (
        <span className="text-ink-faint">[imagen: {alt || String(src)}]</span>
      );
    },
    a: ({ href, children }) => {
      const accion = href && !/^(https?:|mailto:)/i.test(href) ? (resolverEnlace?.(href) ?? null) : null;
      if (accion) {
        return (
          <button type="button" onClick={accion} className="text-accent underline decoration-accent/40 hover:decoration-accent">
            {children}
          </button>
        );
      }
      return href && /^(https?:|mailto:)/i.test(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 hover:decoration-accent">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto rounded border border-line">
        <table className="w-full border-collapse text-[11px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface-2 text-ink">{children}</thead>,
    th: ({ children, style }) => (
      <th style={style} className="border-b border-line px-2 py-1 text-left font-semibold">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border-b border-line/60 px-2 py-1 align-top">
        {children}
      </td>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const texto = String(children ?? "");
      const lenguaje = /language-([\w-]+)/.exec(className ?? "")?.[1];
      // Un bloque (con lenguaje o con saltos de línea) va aparte; el resto es
      // código en línea.
      if (lenguaje || texto.includes("\n")) {
        return <BloqueDeCodigo codigo={texto.replace(/\n$/, "")} lenguaje={lenguaje ?? null} />;
      }
      const ruta = /^([\w./@-]+?)(?::(\d+))?$/.exec(texto.trim());
      if (ruta && onAbrirArchivo && existentes.has(ruta[1]!)) {
        return (
          <button
            type="button"
            onClick={() => onAbrirArchivo(ruta[1]!, ruta[2] ? Number(ruta[2]) : undefined)}
            title={`Abrir ${ruta[1]}${ruta[2] ? ` en la línea ${ruta[2]}` : ""}`}
            className="rounded bg-accent/10 px-1 py-px font-mono text-[11px] text-accent hover:bg-accent/20 hover:underline"
          >
            {texto}
          </button>
        );
      }
      return <code className="rounded bg-surface-2 px-1 py-px font-mono text-[11px] text-ink">{texto}</code>;
    },
  };

  return (
    <div className={`${grande ? "text-[14px] leading-7" : "text-[12px] leading-relaxed"} break-words text-ink`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={componentes}>
        {texto}
      </ReactMarkdown>
    </div>
  );
}

/** Lenguajes que el markdown nombra distinto que Monaco. */
const ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  py: "python",
  yml: "yaml",
  md: "markdown",
  glsl: "cpp",
  html: "html",
  json: "json",
  css: "css",
};

function BloqueDeCodigo({ codigo, lenguaje }: { codigo: string; lenguaje: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  // Los colores de `colorize` salen del tema activo: se fija acá por si el
  // chat se abre sin ningún editor montado que ya lo haya cargado.
  const tema = useTemaMonaco();
  const idMonaco = lenguaje ? (ALIAS[lenguaje.toLowerCase()] ?? lenguajeDe(`x.${lenguaje}`)) : "plaintext";

  useEffect(() => {
    monaco.editor.setTheme(tema);
    let vivo = true;
    // `colorize` escapa el texto y devuelve spans con clases del tema: no
    // introduce HTML que venga del código.
    monaco.editor
      .colorize(codigo, idMonaco, { tabSize: 2 })
      .then((resultado) => {
        if (vivo) setHtml(resultado);
      })
      .catch(() => setHtml(null));
    return () => {
      vivo = false;
    };
  }, [codigo, idMonaco, tema]);

  const copiar = () => {
    void navigator.clipboard?.writeText(codigo).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    });
  };

  const cuerpo: ReactNode = html ? (
    <div className="monaco-colorizado" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    codigo
  );

  return (
    <div className="group/bloque my-2 overflow-hidden rounded-md border border-line bg-canvas">
      <div className="flex items-center justify-between border-b border-line bg-surface-2 px-2 py-0.5">
        <span className="font-mono text-[10px] text-ink-faint">{lenguaje ?? "texto"}</span>
        <button
          type="button"
          onClick={copiar}
          title="Copiar"
          className="flex items-center gap-1 rounded px-1 text-[10px] text-ink-faint hover:text-ink"
        >
          {copiado ? <Check className="size-3 text-ok" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copiado ? "copiado" : "copiar"}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-snug whitespace-pre text-ink">{cuerpo}</pre>
    </div>
  );
}
