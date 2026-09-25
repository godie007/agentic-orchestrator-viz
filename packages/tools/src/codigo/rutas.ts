import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resuelve una ruta que propuso un modelo **dentro** del worktree.
 *
 * No se reusa `ExportStore.safePath`: ese saneo está pensado para nombres de
 * entregables y rompe código —le saca el punto a `.gitignore`, convierte
 * `[id].tsx` en `-id-.tsx`, corta en seis niveles—. Acá la ruta se respeta tal
 * cual y lo que se verifica es **dónde cae**, que es lo único que importa:
 *
 * - nada absoluto ni con `..` que salga del árbol;
 * - nada adentro de `.git` —un agente que escribe `.git/hooks/pre-commit` o
 *   `.git/config` convierte el próximo checkpoint en ejecución de código—;
 * - y la comprobación final es sobre la ruta **real**, con los symlinks
 *   resueltos, porque `docs -> /Users/persona` es un symlink que un repo
 *   puede traer.
 */
export type RutaResuelta =
  | { ok: true; absoluta: string; relativa: string }
  | { ok: false; motivo: string };

export async function resolverEnWorktree(raiz: string, pedida: string): Promise<RutaResuelta> {
  const limpia = pedida.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!limpia) return { ok: false, motivo: "Falta la ruta." };
  if (isAbsolute(limpia)) {
    return { ok: false, motivo: `Usá rutas relativas a la raíz del repo, no "${limpia}".` };
  }
  const destino = resolve(raiz, limpia);
  const relativa = relative(raiz, destino);
  if (relativa === "" ) return { ok: false, motivo: "Esa ruta es la raíz del repo, no un archivo." };
  if (relativa.startsWith("..") || isAbsolute(relativa)) {
    return { ok: false, motivo: `"${pedida}" se sale del repo.` };
  }
  const partes = relativa.split(sep);
  if (partes[0] === ".git" || partes.includes(".git")) {
    return { ok: false, motivo: "No se lee ni se escribe adentro de .git: el historial lo maneja el orquestador." };
  }

  // El ancestro más profundo que existe, resuelto: si un symlink lo saca del
  // árbol, lo que se cree debajo también cae afuera.
  let existente = destino;
  for (;;) {
    try {
      await lstat(existente);
      break;
    } catch {
      const padre = dirname(existente);
      if (padre === existente) break;
      existente = padre;
    }
  }
  const raizReal = await realpath(raiz);
  let real: string;
  try {
    real = await realpath(existente);
  } catch {
    return { ok: false, motivo: `No se pudo resolver "${pedida}".` };
  }
  const resto = relative(existente, destino);
  const final = resto ? join(real, resto) : real;
  if (final !== raizReal && !final.startsWith(raizReal + sep)) {
    return { ok: false, motivo: `"${pedida}" apunta (por un enlace) afuera del repo.` };
  }
  return { ok: true, absoluta: final, relativa: partes.join("/") };
}
