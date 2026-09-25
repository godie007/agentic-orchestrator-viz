/**
 * Un nombre de archivo o carpeta **legible por una persona**.
 *
 * No se reusa `ExportStore.safeSegment` a propósito: ahí se sacan acentos y
 * espacios porque esos nombres viajan en URLs de descarga. Acá los nombres se
 * leen —en Obsidian, en el Finder—, y una carpeta que dice
 * `inspia-checklist-items-no-expanden` o `cmp_msw30yi82fdt1e` en vez de
 * "INSPIA — Publicidad" no se navega, se descifra. Lo que sí se saca es lo que
 * rompe un filesystem o esconde un archivo: separadores de ruta, caracteres de
 * control, y el punto inicial.
 *
 * Vive en `@orq/shared` porque la usan dos árboles —el vault de contexto y las
 * carpetas de proyecto— y con dos copias de la regla la misma empresa terminaba
 * con dos nombres distintos según dónde se mirara.
 */
export function segmentoLegible(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
}

/**
 * Un nombre apto para una rama de git o una carpeta técnica: minúsculas, sin
 * acentos, guiones. `Mi Repo (v2)` → `mi-repo-v2`.
 */
export function slugTecnico(raw: string, fallback = "sin-nombre"): string {
  const slug = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 60);
  return slug || fallback;
}
