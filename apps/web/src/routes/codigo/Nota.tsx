import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronRight, FileText } from "lucide-react";
import { api } from "../../api.js";
import { Markdown } from "./Markdown.js";

/**
 * Una nota de Obsidian leída como en Obsidian: con los `[[enlaces]]` andando,
 * las imágenes embebidas (`![[diagrama.png]]`) a la vista y las propiedades
 * del frontmatter arriba, en vez de un bloque YAML crudo.
 *
 * Es la documentación del proyecto —en INSPIA, `inspia-obsidian/` con la
 * arquitectura, las reglas de negocio y los flujos—, y leerla en el mismo IDE
 * donde se cambia el código es lo que evita que un cambio contradiga una regla
 * escrita dos carpetas más allá.
 */

/** `[[Nota]]` → la ruta del archivo. Primero en la misma carpeta, después en cualquier lado. */
export function resolverNota(nombre: string, desde: string, archivos: readonly string[]): string | null {
  const limpio = nombre.split("#")[0]!.split("|")[0]!.trim();
  if (!limpio) return null;
  const buscado = limpio.toLowerCase().replace(/\.md$/, "");
  const carpeta = desde.includes("/") ? desde.slice(0, desde.lastIndexOf("/") + 1) : "";
  const candidatos = archivos.filter((a) => {
    const sinExt = a.toLowerCase().replace(/\.md$/, "");
    const base = sinExt.split("/").at(-1);
    return sinExt === buscado || sinExt.endsWith(`/${buscado}`) || base === buscado || a.toLowerCase() === limpio.toLowerCase();
  });
  return candidatos.find((a) => a.startsWith(carpeta)) ?? candidatos[0] ?? null;
}

/** Relativa a la nota (`../img/x.png`, `Otra nota.md`) → ruta del repo. */
function relativaA(desde: string, destino: string): string {
  const partes = desde.split("/").slice(0, -1);
  for (const parte of decodeURIComponent(destino).split("/")) {
    if (parte === "..") partes.pop();
    else if (parte && parte !== ".") partes.push(parte);
  }
  return partes.join("/");
}

/** Frontmatter aparte, y la sintaxis de Obsidian pasada a markdown común. */
export function prepararNota(texto: string): { propiedades: Array<[string, string]>; cuerpo: string } {
  let cuerpo = texto;
  const propiedades: Array<[string, string]> = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(texto);
  if (m) {
    cuerpo = texto.slice(m[0].length);
    for (const linea of m[1]!.split(/\r?\n/)) {
      // Una lista en YAML (`tags:` y abajo `  - x`) se suma a la propiedad anterior.
      const item = /^\s*-\s+(.*)$/.exec(linea);
      const ultima = propiedades.at(-1);
      if (item && ultima) {
        ultima[1] = [ultima[1], item[1]!.trim().replace(/^["']|["']$/g, "")].filter(Boolean).join(", ");
        continue;
      }
      const i = linea.indexOf(":");
      if (i > 0 && !linea.startsWith(" ")) propiedades.push([linea.slice(0, i).trim(), linea.slice(i + 1).trim().replace(/^["']|["']$/g, "").replace(/^\[(.*)\]$/, "$1")]);
    }
  }
  // El código se deja tal cual: un `[[enlace]]` escrito como ejemplo adentro
  // de backticks no es un enlace. Se parte el texto en bloques de código,
  // código en línea y el resto, y sólo el resto se transforma.
  cuerpo = cuerpo
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((tramo, i) => (i % 2 === 1 ? tramo : sintaxisDeObsidian(tramo)))
    .join("");
  return { propiedades, cuerpo };
}

const CALLOUT: Record<string, string> = {
  info: "ℹ️", note: "📝", tip: "💡", hint: "💡", important: "❗", warning: "⚠️", caution: "⚠️",
  danger: "⛔", error: "⛔", bug: "🐞", example: "🧪", quote: "❝", success: "✅", check: "✅", question: "❓", todo: "☑️",
};

function sintaxisDeObsidian(texto: string): string {
  return (
    texto
      // ![[imagen.png]] y ![[imagen.png|300]]
      .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, destino: string) => `![${destino}](#wiki-img:${encodeURIComponent(destino.trim())})`)
      // [[Nota]], [[Nota|alias]], [[Nota#sección]]
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, destino: string, alias?: string) => `[${(alias ?? destino).trim()}](#wiki:${encodeURIComponent(destino.trim())})`)
      // Callouts: `> [!info] Título` → una cita con su ícono y el título en negrita.
      .replace(/^(\s*>\s*)\[!(\w+)\][+-]?\s*(.*)$/gm, (_, prefijo: string, tipo: string, titulo: string) => {
        const icono = CALLOUT[tipo.toLowerCase()] ?? "📌";
        return `${prefijo}${icono} **${titulo.trim() || tipo.charAt(0).toUpperCase() + tipo.slice(1)}**  `;
      })
  );
}

export function Nota({
  repoId,
  ruta,
  archivos,
  onAbrir,
}: {
  repoId: string;
  ruta: string;
  archivos: readonly string[];
  onAbrir: (ruta: string) => void;
}) {
  const archivo = useQuery({
    queryKey: ["archivo", repoId, ruta],
    queryFn: () => api.archivo(repoId, ruta),
    refetchInterval: 5_000,
  });
  const { propiedades, cuerpo } = useMemo(() => prepararNota(archivo.data?.contenido ?? ""), [archivo.data]);
  const [roto, setRoto] = useState<string | null>(null);

  const resolverEnlace = (href: string): (() => void) | null => {
    if (href.startsWith("#wiki:")) {
      const destino = decodeURIComponent(href.slice(6));
      const encontrada = resolverNota(destino, ruta, archivos);
      return () => (encontrada ? onAbrir(encontrada) : setRoto(destino));
    }
    if (href.startsWith("#")) return null;
    const destino = relativaA(ruta, href.split("#")[0]!);
    return archivos.includes(destino) ? () => onAbrir(destino) : null;
  };
  const resolverImagen = (src: string): string | null => {
    if (src.startsWith("#wiki-img:")) {
      const nombre = decodeURIComponent(src.slice(10));
      const encontrada = archivos.find((a) => a === nombre || a.endsWith(`/${nombre}`));
      return encontrada ? api.vistaUrl(repoId, encontrada) : null;
    }
    const destino = relativaA(ruta, src);
    return archivos.includes(destino) ? api.vistaUrl(repoId, destino) : null;
  };

  if (archivo.isLoading) return <div className="p-6 text-[13px] text-ink-faint">Cargando…</div>;
  if (archivo.data?.contenido == null) return <div className="p-6 text-[13px] text-ink-faint">No se pudo leer la nota.</div>;

  return (
    <div className="h-full min-h-0 overflow-auto bg-canvas">
      <article className="mx-auto max-w-3xl px-8 py-8">
        {propiedades.length > 0 && (
          <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded border border-line bg-surface px-3 py-2 text-[12px]">
            {propiedades.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-faint">{k}</dt>
                <dd className="min-w-0 break-words text-ink-dim">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {roto && (
          <p className="mb-4 rounded border border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
            No hay ninguna nota "{roto}" en el repo: el enlace está roto.
          </p>
        )}
        <Markdown texto={cuerpo} archivos={archivos} grande resolverEnlace={resolverEnlace} resolverImagen={resolverImagen} />
      </article>
    </div>
  );
}

/** Las notas de una carpeta de documentación, en árbol, para ir de una a otra. */
export function IndiceDeNotas({
  carpeta,
  archivos,
  activa,
  onAbrir,
}: {
  carpeta: string;
  archivos: readonly string[];
  activa: string | null;
  onAbrir: (ruta: string) => void;
}) {
  const prefijo = carpeta ? `${carpeta}/` : "";
  const notas = archivos.filter((a) => a.startsWith(prefijo) && a.toLowerCase().endsWith(".md")).sort((a, b) => a.localeCompare(b, "es"));
  const grupos = new Map<string, string[]>();
  for (const nota of notas) {
    const resto = nota.slice(prefijo.length);
    const grupo = resto.includes("/") ? resto.slice(0, resto.indexOf("/")) : "";
    grupos.set(grupo, [...(grupos.get(grupo) ?? []), nota]);
  }
  const [cerrados, setCerrados] = useState<Set<string>>(new Set());

  return (
    <nav className="h-full min-h-0 overflow-auto border-r border-line bg-surface py-2 text-[12px]">
      <div className="mb-1 flex items-center gap-1.5 px-3 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
        <BookOpen className="size-3.5" aria-hidden /> {carpeta || "Documentación"}
      </div>
      {[...grupos.entries()].map(([grupo, lista]) => (
        <div key={grupo || "_"}>
          {grupo && (
            <button
              type="button"
              onClick={() =>
                setCerrados((c) => {
                  const nuevo = new Set(c);
                  if (nuevo.has(grupo)) nuevo.delete(grupo);
                  else nuevo.add(grupo);
                  return nuevo;
                })
              }
              className="flex w-full items-center gap-1 px-2 py-0.5 text-left font-medium text-ink-dim hover:text-ink"
            >
              {cerrados.has(grupo) ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
              <span className="truncate">{grupo}</span>
            </button>
          )}
          {!cerrados.has(grupo) &&
            lista.map((nota) => (
              <button
                key={nota}
                type="button"
                onClick={() => onAbrir(nota)}
                title={nota}
                className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left hover:bg-surface-2 ${grupo ? "pl-6" : "pl-3"} ${
                  activa === nota ? "bg-accent/10 text-ink" : "text-ink-dim"
                }`}
              >
                <FileText className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span className="truncate">{nota.split("/").at(-1)!.replace(/\.md$/i, "")}</span>
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
