/**
 * Un glob de archivos como expresión regular: `**`, `*`, `?` y `{a,b}`.
 *
 * Es lo que usa `buscar_archivos` sobre la lista de `git ls-files`. No hace
 * falta una dependencia para esto, y la semántica es la que un agente espera
 * de cualquier herramienta de código: `*` no cruza carpetas, `**` sí.
 */
export function globARegex(glob: string): RegExp {
  let fuente = "";
  let llaves = 0;
  const patron = glob.trim().replace(/^\.\//, "");
  for (let i = 0; i < patron.length; i++) {
    const c = patron[i]!;
    if (c === "*") {
      if (patron[i + 1] === "*") {
        const conBarra = patron[i + 2] === "/";
        fuente += conBarra ? "(?:.*/)?" : ".*";
        i += conBarra ? 2 : 1;
      } else {
        fuente += "[^/]*";
      }
    } else if (c === "?") fuente += "[^/]";
    else if (c === "{") {
      llaves++;
      fuente += "(?:";
    } else if (c === "}" && llaves > 0) {
      llaves--;
      fuente += ")";
    } else if (c === "," && llaves > 0) fuente += "|";
    else fuente += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // Un patrón sin barra matchea el nombre en cualquier carpeta: `*.ts` es
  // "cualquier .ts", que es lo que quiere decir quien lo escribe.
  const anclado = patron.includes("/") ? `^${fuente}$` : `(?:^|/)${fuente}$`;
  return new RegExp(anclado);
}
