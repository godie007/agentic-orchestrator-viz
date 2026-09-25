import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MAX_PAQUETES_POR_PEDIDO,
  argvATexto,
  argvDeInstalacion,
  decidirComando,
  gestorPorArchivos,
  tokenizar,
  validarPaquete,
} from "@orq/shared";
import { fail, ok, type RegisteredTool, type ToolContext, type ToolResult } from "../types.js";
import { globARegex } from "./glob.js";
import { mapaDelCodigo } from "./indice.js";
import { resolverEnWorktree } from "./rutas.js";
import type { CodigoStorage, EspacioDeCodigo, ServicioParaAgente } from "./tipos.js";

export type {
  CodigoStorage,
  EspacioDeCodigo,
  PedidoHttp,
  RespuestaHttp,
  ResultadoComando,
  ResultadoGitCodigo,
  ServicioParaAgente,
} from "./tipos.js";
export { ejecutarComando, entornoDeComando, entornoDeServicio, hayAislamiento, perfilSandbox } from "./ejecutar.js";
export { mapaDelCodigo, extraerSimbolos, olvidarIndice } from "./indice.js";
export { resolverEnWorktree } from "./rutas.js";
export { globARegex } from "./glob.js";

/**
 * Las herramientas para programar sobre un repo cargado.
 *
 * Son `origin: "skill"` —siempre expuestas, sembradas y otorgadas por rol— y
 * sólo se registran si el proyecto tiene un repo: una herramienta que no se
 * puede cumplir hace gastar turnos intentándola.
 *
 * El diseño toma lo que funciona en los harness de código que ya existen:
 * editar por **reemplazo exacto y único** (el `str_replace` de Claude Code y
 * del editor de SWE-agent), leer con **números de línea** y por ventanas, buscar
 * con `git grep` y orientarse con un **mapa de símbolos** (el repo map de
 * Aider). Lo que es propio es dónde viven los frenos: el arriendo de escritura,
 * la allowlist y el sandbox los aplica el ejecutor, no el prompt.
 */

/** Cuánto se lee por default. Acoplado a `TOPE_RESULTADO` (16.000) de `acotar.ts`. */
export const LINEAS_POR_LECTURA = 350;
const TOPE_CARACTERES_LECTURA = 15_000;
const TOPE_ARCHIVO_EDITABLE = 1024 * 1024;
const TOPE_BUSQUEDA = 12_000;

/** Nombres de las herramientas que escriben el árbol: sin arriendo, no corren. */
export const HERRAMIENTAS_QUE_ESCRIBEN_CODIGO = new Set([
  "editar_codigo",
  "escribir_codigo",
  "aplicar_parche",
  "revertir_codigo",
]);

const REPO = {
  repo: {
    type: "string",
    description: "Nombre o id del repo. Opcional si el proyecto tiene uno solo.",
  },
} as const;

async function espacioO(
  storage: CodigoStorage,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: true; espacio: EspacioDeCodigo } | { ok: false; resultado: ToolResult }> {
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
  const espacio = await storage.espacio(repo, ctx);
  return espacio.ok ? espacio : { ok: false, resultado: fail(espacio.motivo) };
}

function conEscritura(storage: CodigoStorage, espacio: EspacioDeCodigo, ctx: ToolContext): ToolResult | null {
  const permiso = storage.puedeEscribir(espacio.repoId, ctx);
  return permiso.ok ? null : fail(permiso.motivo);
}

async function archivosDelRepo(storage: CodigoStorage, espacio: EspacioDeCodigo): Promise<string[]> {
  // `-co --exclude-standard`: también lo que un agente creó y todavía no entró
  // a un checkpoint. Con `ls-files` a secas, un archivo nuevo no existía.
  const salida = await storage.git(espacio, ["ls-files", "-z", "-co", "--exclude-standard"]);
  return salida.stdout.split("\0").filter(Boolean).sort();
}

function numerar(lineas: string[], desde: number): string {
  const ancho = String(desde + lineas.length).length;
  return lineas.map((linea, i) => `${String(desde + i).padStart(ancho, " ")}→${linea}`).join("\n");
}

function contarApariciones(texto: string, buscado: string): number[] {
  const posiciones: number[] = [];
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(buscado, desde);
    if (i < 0) break;
    posiciones.push(i);
    desde = i + Math.max(1, buscado.length);
  }
  return posiciones;
}

const lineaDe = (texto: string, posicion: number) => texto.slice(0, posicion).split("\n").length;

/** Un bloque igual salvo espacios: se informa, **no** se aplica. */
function parecidoIgnorandoEspacios(texto: string, buscado: string): number | null {
  const partes = buscado.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (partes.length === 0 || !partes[0]) return null;
  const m = new RegExp(partes.join("\\s+")).exec(texto);
  return m ? lineaDe(texto, m.index) : null;
}

/** La subcarpeta de un comando, validada dentro del worktree. `""` es la raíz. */
async function carpetaDelComando(
  espacio: EspacioDeCodigo,
  pedida: unknown,
): Promise<{ ok: true; relativa: string } | { ok: false; motivo: string }> {
  const texto = typeof pedida === "string" ? pedida.trim().replace(/\/+$/, "") : "";
  if (!texto || texto === ".") return { ok: true, relativa: "" };
  const ruta = await resolverEnWorktree(espacio.dir, texto);
  if (!ruta.ok) return ruta;
  try {
    if (!(await stat(ruta.absoluta)).isDirectory()) return { ok: false, motivo: `"${texto}" no es una carpeta.` };
  } catch {
    return { ok: false, motivo: `No existe la carpeta "${texto}" en el repo.` };
  }
  return { ok: true, relativa: ruta.relativa };
}

const ETIQUETA_TIPO: Record<ServicioParaAgente["tipo"], string> = {
  web: "frontend web",
  api: "API",
  movil: "app móvil (vista web)",
  docs: "documentación",
  otro: "servicio",
};

function lineaDeServicio(s: ServicioParaAgente): string {
  const donde = s.carpeta ? `${s.carpeta}/` : "raíz";
  if (s.tipo === "docs") {
    return `${s.id} — ${ETIQUETA_TIPO.docs} en ${donde}: leela con leer_codigo antes de cambiar reglas de negocio.`;
  }
  const estado =
    s.estado === "listo" && s.url
      ? `levantado en ${s.url}`
      : s.estado === "fallo"
        ? `falló al arrancar${s.detalle ? ` (${s.detalle})` : ""}`
        : s.estado;
  return `${s.id} — ${ETIQUETA_TIPO[s.tipo]} en ${donde}: ${estado}.`;
}

export function crearHerramientasDeCodigo(storage: CodigoStorage): RegisteredTool[] {
  const listarRepositorios: RegisteredTool = {
    name: "listar_repositorios",
    description:
      "Lista los repos de código del proyecto: su sesión de trabajo (rama), cómo se corren los tests, qué comandos podés ejecutar y si en este turno podés escribir. Empezá por acá.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(_args, ctx) {
      const repos = await storage.listar();
      if (repos.length === 0) {
        return ok(
          "El proyecto no tiene repos todavía. Si el encargo es construir un programa nuevo, crealo con crear_repositorio " +
            "—no escribas código en la salida—. Si es sobre código que ya existe, lo carga una persona desde la pestaña Código.",
        );
      }
      const texto = repos
        .map((repo) => {
          const permiso = storage.puedeEscribir(repo.id, ctx);
          const comandos = repo.comandos;
          return [
            `## ${repo.nombre} (id ${repo.id})`,
            `- Rama base: ${repo.ramaBase}. Sesión: ${repo.sesion ? `${repo.sesion.rama}${repo.sesion.commits != null ? `, ${repo.sesion.commits} checkpoint(s)` : ""}` : "se abre al primer uso"}.`,
            `- Tests: ${comandos.test ? argvATexto(comandos.test) : "sin definir"}. Verificar: ${comandos.verificar ? argvATexto(comandos.verificar) : "sin definir"}.`,
            `- Comandos permitidos: ${comandos.permitidos.length ? comandos.permitidos.map((c) => argvATexto(c)).join(" · ") : "ninguno todavía (pedilos con solicitar_comando)"}. git status/diff/log siempre.`,
            `- Escritura en este turno: ${permiso.ok ? "sí, tenés el arriendo" : `no — ${permiso.motivo}`}`,
            ...(repo.pendienteDeConfirmar ? ["- ⚠ La allowlist vino importada y nadie la confirmó: no se ejecuta nada hasta que una persona la revise."] : []),
            ...(repo.servicios.length > 0
              ? [`- Servicios (monorepo: cada uno en su carpeta; los comandos se corren con carpeta="…"):`, ...repo.servicios.map((s) => `  - ${lineaDeServicio(s)}`)]
              : []),
          ].join("\n");
        })
        .join("\n\n");
      return ok(texto);
    },
  };

  const mapa: RegisteredTool = {
    name: "mapa_del_codigo",
    description:
      "Mapa del repo: carpetas, y los archivos más importantes con sus clases, funciones y tipos (nombre:línea), ordenados por cuántos otros archivos los usan. Es la forma barata de orientarse antes de leer. Con 'carpeta' se acota a una parte del repo.",
    inputSchema: {
      type: "object",
      properties: {
        carpeta: { type: "string", description: "Subcarpeta a mapear, ej. 'src/api'." },
        ...REPO,
      },
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const archivos = await archivosDelRepo(storage, e.espacio);
      const carpeta = typeof args.carpeta === "string" ? args.carpeta : undefined;
      return ok(await mapaDelCodigo(e.espacio.dir, archivos, carpeta ? { carpeta } : {}));
    },
  };

  const buscarCodigo: RegisteredTool = {
    name: "buscar_codigo",
    description:
      "Busca una expresión regular en el código (git grep, incluye archivos nuevos). Devuelve archivo:línea:texto. Usala para encontrar dónde se define o se usa algo antes de leer archivos enteros.",
    inputSchema: {
      type: "object",
      properties: {
        patron: { type: "string", description: "Expresión regular extendida, ej. 'function suma|suma\\('." },
        archivos: { type: "string", description: "Glob de archivos donde buscar, ej. 'src/**/*.ts'. Opcional." },
        ignorarMayusculas: { type: "boolean" },
        contexto: { type: "number", description: "Líneas de contexto alrededor de cada coincidencia (0-5)." },
        ...REPO,
      },
      required: ["patron"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const patron = String(args.patron ?? "");
      if (!patron.trim()) return fail("Falta 'patron'.");
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const contexto = Math.max(0, Math.min(5, Number(args.contexto ?? 0) || 0));
      const gitArgs = [
        "grep", "-n", "-I", "-E", "--untracked", "--full-name", "--no-color",
        ...(args.ignorarMayusculas === true ? ["-i"] : []),
        ...(contexto > 0 ? [`-C${contexto}`] : []),
        "-e", patron,
      ];
      if (typeof args.archivos === "string" && args.archivos.trim()) {
        gitArgs.push("--", `:(glob)${args.archivos.trim()}`);
      }
      const r = await storage.git(e.espacio, gitArgs);
      if (r.codigo === 1 && !r.stderr.trim()) return ok(`Sin coincidencias para /${patron}/.`);
      if (!r.ok) return fail(`git grep falló: ${r.stderr.trim().slice(0, 500)}`);
      const lineas = r.stdout.split("\n").filter(Boolean);
      let texto = "";
      let mostradas = 0;
      for (const linea of lineas) {
        const recortada = linea.length > 300 ? `${linea.slice(0, 300)}…` : linea;
        if (texto.length + recortada.length + 1 > TOPE_BUSQUEDA) break;
        texto += `${recortada}\n`;
        mostradas++;
      }
      const resto = lineas.length - mostradas;
      return ok(
        `${lineas.length} línea(s).\n${texto}${
          resto > 0 ? `\n… y ${resto} más. Acotá con 'archivos' o un patrón más específico.` : ""
        }`,
      );
    },
  };

  const buscarArchivos: RegisteredTool = {
    name: "buscar_archivos",
    description:
      "Lista archivos del repo que coinciden con un glob ('**/*.test.ts', 'src/components/*'). Respeta .gitignore e incluye archivos nuevos.",
    inputSchema: {
      type: "object",
      properties: {
        patron: { type: "string", description: "Glob. Sin barra matchea el nombre en cualquier carpeta: '*.py'." },
        ...REPO,
      },
      required: ["patron"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const patron = String(args.patron ?? "").trim();
      if (!patron) return fail("Falta 'patron'.");
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const re = globARegex(patron);
      const todos = await archivosDelRepo(storage, e.espacio);
      const encontrados = todos.filter((ruta) => re.test(ruta));
      if (encontrados.length === 0) return ok(`Ningún archivo coincide con "${patron}" (${todos.length} en el repo).`);
      const mostrados = encontrados.slice(0, 300);
      return ok(
        `${encontrados.length} archivo(s):\n${mostrados.join("\n")}${
          encontrados.length > mostrados.length ? `\n… y ${encontrados.length - mostrados.length} más.` : ""
        }`,
      );
    },
  };

  const leer: RegisteredTool = {
    name: "leer_codigo",
    description:
      `Lee un archivo del repo con números de línea (formato 'N→texto'; el número y la flecha no son parte del archivo). Por default ${LINEAS_POR_LECTURA} líneas desde el principio; para seguir, pedí 'desde' con la línea siguiente.`,
    inputSchema: {
      type: "object",
      properties: {
        ruta: { type: "string", description: "Ruta relativa a la raíz del repo." },
        desde: { type: "number", description: "Primera línea a leer (1 = el principio)." },
        limite: { type: "number", description: `Cuántas líneas (máx. ${LINEAS_POR_LECTURA * 2}).` },
        ...REPO,
      },
      required: ["ruta"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const ruta = await resolverEnWorktree(e.espacio.dir, String(args.ruta ?? ""));
      if (!ruta.ok) return fail(ruta.motivo);
      let info;
      try {
        info = await stat(ruta.absoluta);
      } catch {
        return fail(`No existe "${ruta.relativa}". Buscalo con buscar_archivos.`);
      }
      if (info.isDirectory()) return fail(`"${ruta.relativa}" es una carpeta. Usá buscar_archivos con "${ruta.relativa}/*".`);
      if (info.size > TOPE_ARCHIVO_EDITABLE * 4) return fail(`"${ruta.relativa}" pesa ${Math.round(info.size / 1024)} KB: no es código que se lea entero. Buscá con buscar_codigo.`);
      const contenido = await readFile(ruta.absoluta, "utf8");
      if (contenido.includes("\u0000")) return fail(`"${ruta.relativa}" es binario.`);
      if (contenido.length === 0) return ok(`"${ruta.relativa}" está vacío.`);

      const lineas = contenido.replace(/\r\n/g, "\n").split("\n");
      if (lineas.at(-1) === "") lineas.pop();
      const desde = Math.max(1, Math.floor(Number(args.desde ?? 1)) || 1);
      const limite = Math.max(1, Math.min(LINEAS_POR_LECTURA * 2, Math.floor(Number(args.limite ?? LINEAS_POR_LECTURA)) || LINEAS_POR_LECTURA));
      if (desde > lineas.length) return fail(`"${ruta.relativa}" tiene ${lineas.length} líneas; 'desde' ${desde} queda afuera.`);
      let tramo = lineas.slice(desde - 1, desde - 1 + limite).map((l) => (l.length > 2_000 ? `${l.slice(0, 2_000)}…[línea recortada]` : l));
      let texto = numerar(tramo, desde);
      while (texto.length > TOPE_CARACTERES_LECTURA && tramo.length > 20) {
        tramo = tramo.slice(0, Math.floor(tramo.length * 0.8));
        texto = numerar(tramo, desde);
      }
      const hasta = desde + tramo.length - 1;
      const cabecera = `${ruta.relativa} — líneas ${desde}-${hasta} de ${lineas.length}`;
      const pie = hasta < lineas.length ? `\n[Sigue: pedí desde=${hasta + 1}.]` : "";
      return ok(`${cabecera}\n${texto}${pie}`);
    },
  };

  const editar: RegisteredTool = {
    name: "editar_codigo",
    description:
      "Edita un archivo reemplazando un texto EXACTO por otro. 'buscar' tiene que aparecer una sola vez (copialo tal cual de leer_codigo, con su indentación y sin los números de línea); si aparece varias, agregá contexto o usá todas=true. Para crear un archivo nuevo usá escribir_codigo.",
    inputSchema: {
      type: "object",
      properties: {
        ruta: { type: "string" },
        buscar: { type: "string", description: "Texto exacto a reemplazar." },
        reemplazar: { type: "string", description: "Texto nuevo. Vacío borra lo buscado." },
        todas: { type: "boolean", description: "Reemplazar todas las apariciones." },
        ...REPO,
      },
      required: ["ruta", "buscar", "reemplazar"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const sinPermiso = conEscritura(storage, e.espacio, ctx);
      if (sinPermiso) return sinPermiso;
      const ruta = await resolverEnWorktree(e.espacio.dir, String(args.ruta ?? ""));
      if (!ruta.ok) return fail(ruta.motivo);
      if (typeof args.buscar !== "string" || typeof args.reemplazar !== "string") {
        return fail("Faltan 'buscar' y 'reemplazar' como texto. Si el argumento quedó cortado, editá un tramo más chico.");
      }
      let buscar = args.buscar;
      let reemplazar = args.reemplazar;
      if (!buscar) return fail("'buscar' está vacío. Para escribir un archivo entero usá escribir_codigo.");
      if (buscar === reemplazar) return fail("'buscar' y 'reemplazar' son iguales: no cambia nada.");

      let original: string;
      try {
        original = await readFile(ruta.absoluta, "utf8");
      } catch {
        return fail(`No existe "${ruta.relativa}". Para crearlo usá escribir_codigo.`);
      }
      if (original.length > TOPE_ARCHIVO_EDITABLE) return fail(`"${ruta.relativa}" es demasiado grande para editar acá.`);
      // Se conservan los finales de línea del archivo: un archivo CRLF editado
      // con LF queda mezclado y el diff marca cada línea como cambiada.
      if (original.includes("\r\n") && !buscar.includes("\r\n")) {
        buscar = buscar.replace(/\n/g, "\r\n");
        reemplazar = reemplazar.replace(/\n/g, "\r\n");
      }

      const posiciones = contarApariciones(original, buscar);
      if (posiciones.length === 0) {
        const parecido = parecidoIgnorandoEspacios(original, buscar);
        return fail(
          parecido
            ? `No aparece exacto en "${ruta.relativa}", pero hay un bloque igual salvo espacios o indentación en la línea ${parecido}. Leelo con leer_codigo desde=${parecido} y copiá el texto EXACTO —en Python o YAML la indentación es parte del código, por eso no se aplica solo—.`
            : `No aparece en "${ruta.relativa}". Releé el archivo con leer_codigo: puede haber cambiado desde que lo leíste.`,
        );
      }
      if (posiciones.length > 1 && args.todas !== true) {
        return fail(
          `Aparece ${posiciones.length} veces en "${ruta.relativa}" (líneas ${posiciones.map((p) => lineaDe(original, p)).join(", ")}). Agregá líneas de contexto a 'buscar' para que sea único, o usá todas=true.`,
        );
      }
      const nuevo = args.todas === true ? original.split(buscar).join(reemplazar) : original.replace(buscar, () => reemplazar);
      await writeFile(ruta.absoluta, nuevo, "utf8");

      // Se devuelve el tramo editado con números: es lo que el agente necesita
      // para la próxima edición sin volver a leer el archivo entero.
      const lineaInicio = lineaDe(nuevo, posiciones[0]!);
      const lineas = nuevo.replace(/\r\n/g, "\n").split("\n");
      const desde = Math.max(1, lineaInicio - 3);
      const cuantas = reemplazar.split("\n").length + 6;
      return ok(
        `Editado ${ruta.relativa} (${posiciones.length > 1 ? `${posiciones.length} reemplazos` : "1 reemplazo"}). Así quedó:\n${numerar(lineas.slice(desde - 1, desde - 1 + cuantas), desde)}`,
      );
    },
  };

  const escribir: RegisteredTool = {
    name: "escribir_codigo",
    description:
      "Crea un archivo nuevo o reemplaza uno entero. Para cambiar una parte de un archivo existente usá editar_codigo: reescribir un archivo entero para cambiar tres líneas es la forma más común de romper lo que no se miró.",
    inputSchema: {
      type: "object",
      properties: {
        ruta: { type: "string" },
        contenido: { type: "string" },
        ...REPO,
      },
      required: ["ruta", "contenido"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const sinPermiso = conEscritura(storage, e.espacio, ctx);
      if (sinPermiso) return sinPermiso;
      const ruta = await resolverEnWorktree(e.espacio.dir, String(args.ruta ?? ""));
      if (!ruta.ok) return fail(ruta.motivo);
      if (typeof args.contenido !== "string") return fail("Falta 'contenido' como texto.");
      if (args.contenido.length > TOPE_ARCHIVO_EDITABLE) return fail("El contenido supera 1 MB: eso no es un archivo de código.");
      const existia = await stat(ruta.absoluta).then(() => true, () => false);
      await mkdir(dirname(ruta.absoluta), { recursive: true });
      await writeFile(ruta.absoluta, args.contenido, "utf8");
      return ok(`${existia ? "Reemplazado" : "Creado"} ${ruta.relativa} (${args.contenido.split("\n").length} líneas).`);
    },
  };

  const parche: RegisteredTool = {
    name: "aplicar_parche",
    description:
      "Aplica un diff unificado (formato git diff, con rutas a/ y b/) que puede tocar varios archivos. Se verifica completo antes de aplicar: o entra todo o no se toca nada.",
    inputSchema: {
      type: "object",
      properties: {
        parche: { type: "string", description: "El diff unificado." },
        ...REPO,
      },
      required: ["parche"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const sinPermiso = conEscritura(storage, e.espacio, ctx);
      if (sinPermiso) return sinPermiso;
      const texto = typeof args.parche === "string" ? args.parche : "";
      if (!texto.trim()) return fail("Falta 'parche'.");
      // Ninguna ruta del parche puede tocar .git ni salirse del repo.
      for (const m of texto.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) {
        const destino = m[1]!;
        if (destino === "/dev/null") continue;
        const ruta = await resolverEnWorktree(e.espacio.dir, destino);
        if (!ruta.ok) return fail(`El parche toca "${destino}": ${ruta.motivo}`);
      }
      const entrada = texto.endsWith("\n") ? texto : `${texto}\n`;
      const prueba = await storage.git(e.espacio, ["apply", "--check", "--recount", "--whitespace=nowarn", "-"], { entrada });
      if (!prueba.ok) {
        return fail(
          `El parche no aplica, no se tocó nada:\n${prueba.stderr.trim().slice(0, 1_500)}\nReleé los archivos: el contexto del diff tiene que coincidir con lo que hay ahora.`,
        );
      }
      const aplicado = await storage.git(e.espacio, ["apply", "--recount", "--whitespace=nowarn", "--stat", "--apply", "-"], { entrada });
      if (!aplicado.ok) return fail(`No se pudo aplicar: ${aplicado.stderr.trim().slice(0, 1_500)}`);
      return ok(`Parche aplicado.\n${aplicado.stdout.trim()}`);
    },
  };

  const estado: RegisteredTool = {
    name: "estado_git",
    description:
      "Qué cambió en la sesión respecto de la base: archivos tocados y, con 'ruta' o conDiff=true, el diff. Sirve para revisar el trabajo propio o el de otro rol antes de dar algo por terminado.",
    inputSchema: {
      type: "object",
      properties: {
        ruta: { type: "string", description: "Mostrar el diff de este archivo." },
        conDiff: { type: "boolean", description: "Incluir el diff completo (acotado)." },
        ...REPO,
      },
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const { espacio } = e;
      const base = espacio.baseSha || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      await storage.git(espacio, ["add", "-A", "--intent-to-add"]);
      const resumen = await storage.git(espacio, ["diff", "--stat=120", "--no-color", base]);
      const commits = await storage.git(espacio, ["log", "--format=%h %an: %s", `${espacio.baseSha ? `${espacio.baseSha}..` : ""}HEAD`]);
      let texto =
        `Sesión ${espacio.rama} (base ${espacio.baseSha.slice(0, 8) || "vacía"}).\n` +
        `Checkpoints:\n${commits.stdout.trim() || "(ninguno todavía)"}\n\n` +
        `Cambios contra la base:\n${resumen.stdout.trim() || "(sin cambios)"}`;
      const ruta = typeof args.ruta === "string" && args.ruta.trim() ? args.ruta.trim() : null;
      if (ruta || args.conDiff === true) {
        if (ruta) {
          const r = await resolverEnWorktree(espacio.dir, ruta);
          if (!r.ok) return fail(r.motivo);
        }
        const diff = await storage.git(espacio, ["diff", "--no-color", "--no-ext-diff", base, ...(ruta ? ["--", ruta] : [])]);
        const cuerpo = diff.stdout.length > TOPE_BUSQUEDA ? `${diff.stdout.slice(0, TOPE_BUSQUEDA)}\n[… diff recortado: pedilo por 'ruta' …]` : diff.stdout;
        texto += `\n\n${cuerpo || "(sin diferencias)"}`;
      }
      return ok(texto);
    },
  };

  const revertir: RegisteredTool = {
    name: "revertir_codigo",
    description:
      "Deshace cambios: con 'ruta', vuelve ese archivo a como estaba en el último checkpoint (o lo borra si es nuevo); con 'checkpoint', revierte ese commit de la sesión (queda un commit nuevo que lo deshace).",
    inputSchema: {
      type: "object",
      properties: {
        ruta: { type: "string" },
        checkpoint: { type: "string", description: "Sha (o prefijo) de un checkpoint de esta sesión." },
        ...REPO,
      },
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const sinPermiso = conEscritura(storage, e.espacio, ctx);
      if (sinPermiso) return sinPermiso;
      const { espacio } = e;
      if (typeof args.ruta === "string" && args.ruta.trim()) {
        const ruta = await resolverEnWorktree(espacio.dir, args.ruta);
        if (!ruta.ok) return fail(ruta.motivo);
        const enHead = await storage.git(espacio, ["cat-file", "-e", `HEAD:${ruta.relativa}`]);
        if (!enHead.ok) {
          await rm(ruta.absoluta, { force: true });
          await storage.git(espacio, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ruta.relativa]);
          return ok(`${ruta.relativa} era nuevo: se borró.`);
        }
        const r = await storage.git(espacio, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ruta.relativa]);
        return r.ok ? ok(`${ruta.relativa} volvió al último checkpoint.`) : fail(r.stderr.trim());
      }
      if (typeof args.checkpoint === "string" && /^[0-9a-f]{6,40}$/i.test(args.checkpoint.trim())) {
        const sha = args.checkpoint.trim();
        if (espacio.baseSha) {
          const dentro = await storage.git(espacio, ["merge-base", "--is-ancestor", espacio.baseSha, sha]);
          const esBase = (await storage.git(espacio, ["rev-parse", sha])).stdout.trim() === espacio.baseSha;
          if (!dentro.ok || esBase) return fail("Ese commit no es un checkpoint de esta sesión.");
        }
        const r = await storage.git(espacio, ["revert", "--no-edit", sha]);
        if (!r.ok) {
          await storage.git(espacio, ["revert", "--abort"]);
          return fail(`No se pudo revertir limpio: ${r.stderr.trim().slice(0, 800)}`);
        }
        return ok(`Revertido ${sha.slice(0, 8)}.`);
      }
      return fail("Indicá 'ruta' o 'checkpoint'.");
    },
  };

  const ejecutar: RegisteredTool = {
    name: "ejecutar_comando",
    description:
      "Corre un comando en el repo —en la raíz o en una subcarpeta con 'carpeta'— (tests, typecheck, build) y devuelve el código de salida y la salida. Sin shell: nada de &&, |, > ni $(…); un comando por llamada. Sólo corre lo permitido para el repo (listar_repositorios lo muestra); lo demás se pide con solicitar_comando. Un exit distinto de 0 no es un error de la herramienta: es el resultado (por ejemplo, tests que fallan).",
    inputSchema: {
      type: "object",
      properties: {
        comando: { type: "string", description: "Ej.: 'npm test -- -t suma' o 'pytest tests/test_api.py -q'." },
        segundos: { type: "number", description: "Corte por tiempo (default 120, máx. 600)." },
        repetir: {
          type: "boolean",
          description:
            "Correrlo aunque el árbol no haya cambiado desde la última vez (por defecto se reutiliza ese resultado). Usalo sólo si sospechás un test inestable.",
        },
        carpeta: {
          type: "string",
          description: "Subcarpeta donde correrlo, en un monorepo (ej. 'backend'): ahí está su package.json. Default: la raíz.",
        },
        ...REPO,
      },
      required: ["comando"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const tokens = tokenizar(String(args.comando ?? ""));
      if (!tokens.ok) return fail(tokens.motivo);
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const { espacio } = e;
      if (espacio.pendienteDeConfirmar) {
        return fail("Los comandos de este repo vinieron importados y una persona todavía no los confirmó. No se ejecuta nada hasta entonces.");
      }
      const decision = decidirComando(tokens.argv, espacio.comandos);
      if (!decision.permitido) return fail(decision.motivo);
      const carpeta = await carpetaDelComando(espacio, args.carpeta);
      if (!carpeta.ok) return fail(carpeta.motivo);

      const segundos = Math.max(5, Math.min(600, Number(args.segundos ?? 120) || 120));
      const resultado = await storage.ejecutar(espacio, tokens.argv, {
        corteMs: segundos * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(args.repetir === true ? { repetir: true } : {}),
        ...(carpeta.relativa ? { carpeta: carpeta.relativa } : {}),
      });
      if (decision.motivo === "una-vez") await storage.consumirUnaVez(espacio.repoId, tokens.argv);

      const comando = `${carpeta.relativa ? `(${carpeta.relativa}) ` : ""}${argvATexto(tokens.argv)}`;
      if (resultado.error) return fail(`No se pudo correr "${comando}": ${resultado.error}`);
      if (resultado.cortadoPorTiempo) {
        return fail(
          `"${comando}" no terminó en ${segundos} s y se cortó. Si es un modo watch o un servidor, no es algo que se corra acá; si es lento de verdad, pedí más 'segundos' o acotá (un archivo de tests, un -t).\n\n${resultado.salida}`,
        );
      }
      // Exit ≠ 0 vuelve como ok: si fuera fail, corregir → testear → corregir
      // chocaría contra el freno de llamadas idénticas fallidas a la tercera.
      const reutilizado =
        resultado.reutilizadoHaceMs != null
          ? `\n(Resultado reutilizado: el árbol no cambió desde que se corrió hace ${Math.round(resultado.reutilizadoHaceMs / 1000)} s, así que volver a correrlo daría lo mismo. Si sospechás un test inestable, pedilo con repetir=true.)`
          : "";
      const encabezado = `$ ${comando}\nexit ${resultado.codigo} · ${(resultado.duracionMs / 1000).toFixed(1)} s · ${
        resultado.aislamiento === "sandbox" ? "en sandbox" : "SIN aislamiento"
      }${resultado.log ? ` · log completo: ${resultado.log}` : ""}${reutilizado}`;
      return ok(`${encabezado}\n\n${resultado.salida || "(sin salida)"}`, `exit ${resultado.codigo}`);
    },
  };

  const solicitar: RegisteredTool = {
    name: "solicitar_comando",
    description:
      "Pide a una persona que permita un comando que hoy no podés correr. Ella decide si queda permitido siempre (como prefijo) o sólo esta vez. Explicá para qué lo necesitás. Mientras tanto, seguí con lo que sí podés hacer.",
    inputSchema: {
      type: "object",
      properties: {
        comando: { type: "string" },
        motivo: { type: "string", description: "Para qué lo necesitás. Es lo que lee la persona para decidir." },
        ...REPO,
      },
      required: ["comando", "motivo"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const tokens = tokenizar(String(args.comando ?? ""));
      if (!tokens.ok) return fail(tokens.motivo);
      const motivo = String(args.motivo ?? "").trim();
      if (!motivo) return fail("Falta 'motivo': sin eso la persona no puede decidir.");
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const decision = decidirComando(tokens.argv, e.espacio.comandos);
      if (decision.permitido) return ok(`"${argvATexto(tokens.argv)}" ya está permitido: corrélo con ejecutar_comando.`);
      const pendiente = ctx.workspace
        .listRequests()
        .find(
          (r) =>
            r.status === "pending" &&
            r.type === "comando" &&
            r.comando?.repoId === e.espacio.repoId &&
            r.comando.argv.join("\u0000") === tokens.argv.join("\u0000"),
        );
      if (pendiente) return ok("Ya hay una solicitud pendiente por ese comando. Seguí con otra cosa mientras tanto.");
      const request = await ctx.workspace.createRequest({
        type: "comando",
        reason: motivo,
        roleProposal: null,
        question: null,
        toolNames: [],
        comando: { repoId: e.espacio.repoId, argv: tokens.argv },
      });
      return ok(
        `Solicitud ${request.id} enviada: "${argvATexto(tokens.argv)}" en ${e.espacio.nombre}. Te llega la respuesta en la bandeja. No la esperes: seguí con lo que sí podés hacer.`,
      );
    },
  };

  const crearRepositorio: RegisteredTool = {
    name: "crear_repositorio",
    description:
      "Crea un repo vacío para un programa NUEVO (con git, rama de trabajo, vista previa y comandos para testear). Usalo cuando el encargo pide construir software desde cero y no hay un repo donde ponerlo: el código nunca va a la salida. Después escribí los archivos con escribir_codigo pasando repo=<nombre>.",
    inputSchema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre corto del programa, ej. 'simulador-balistico'." },
        descripcion: { type: "string", description: "Qué es, en una o dos frases. Va al README." },
      },
      required: ["nombre"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const nombre = String(args.nombre ?? "").trim();
      if (!nombre) return fail("Falta 'nombre'.");
      const creado = await storage.crear(nombre, String(args.descripcion ?? "").trim(), ctx);
      if (!creado.ok) return fail(creado.motivo);
      return ok(
        `Repo "${creado.repo.nombre}" creado (id ${creado.repo.id}), con una rama de trabajo lista. ` +
          `Escribí los archivos con escribir_codigo repo="${creado.repo.nombre}" y corré los tests con ejecutar_comando ` +
          `(ya están permitidos npm test, node --test y node --check). Aparece en la pestaña Código como una carpeta propia.`,
      );
    },
  };

  const instalar: RegisteredTool = {
    name: "instalar_dependencia",
    description:
      "Pide instalar librerías del registro de npm en el repo (ej. three@0.160.0). Una persona lo aprueba y al aprobar se instala solo —sin scripts de instalación— y queda commiteado en package.json; te llega el resultado a la bandeja. Es la única forma de traer una dependencia: no la bajes con curl ni la copies a mano. Mientras se aprueba, seguí con lo que no dependa de ella.",
    inputSchema: {
      type: "object",
      properties: {
        paquetes: {
          type: "array",
          items: { type: "string" },
          description: "Nombres del registro, con versión si importa: ['three@0.160.0'].",
        },
        dev: { type: "boolean", description: "Dependencia de desarrollo (tests, build)." },
        motivo: { type: "string", description: "Para qué la necesitás. Es lo que lee la persona para decidir." },
        carpeta: {
          type: "string",
          description: "En un monorepo, la parte que la necesita (ej. 'frontend'): ahí está su package.json. Default: la raíz.",
        },
        ...REPO,
      },
      required: ["paquetes", "motivo"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const paquetes = Array.isArray(args.paquetes)
        ? args.paquetes.map((p) => String(p).trim()).filter(Boolean)
        : [];
      if (paquetes.length === 0) return fail("Falta 'paquetes'.");
      if (paquetes.length > MAX_PAQUETES_POR_PEDIDO) {
        return fail(`Son muchos paquetes para un pedido (máx. ${MAX_PAQUETES_POR_PEDIDO}): pedí lo que necesitás ahora.`);
      }
      for (const paquete of paquetes) {
        const v = validarPaquete(paquete);
        if (!v.ok) return fail(v.motivo);
      }
      const motivo = String(args.motivo ?? "").trim();
      if (!motivo) return fail("Falta 'motivo': sin eso la persona no puede decidir.");
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const carpeta = await carpetaDelComando(e.espacio, args.carpeta);
      if (!carpeta.ok) return fail(carpeta.motivo);
      const prefijo = carpeta.relativa ? `${carpeta.relativa}/` : "";
      const archivos = (await archivosDelRepo(storage, e.espacio))
        .filter((ruta) => ruta.startsWith(prefijo))
        .map((ruta) => ruta.slice(prefijo.length));
      if (!archivos.includes("package.json")) {
        return fail(
          carpeta.relativa
            ? `No hay package.json en ${carpeta.relativa}/.`
            : "El repo no tiene package.json en la raíz. Si es un monorepo, decí en qué parte va con carpeta=\"frontend\" (o la que sea); si no, creá uno con escribir_codigo.",
        );
      }
      const gestor = gestorPorArchivos(archivos);
      const pendiente = ctx.workspace
        .listRequests()
        .find(
          (r) =>
            r.status === "pending" &&
            r.type === "dependencia" &&
            r.dependencia?.repoId === e.espacio.repoId &&
            (r.dependencia?.carpeta ?? "") === carpeta.relativa &&
            paquetes.every((p) => r.dependencia?.paquetes.includes(p)),
        );
      if (pendiente) return ok("Ya hay una solicitud pendiente por esos paquetes. Seguí con otra cosa mientras tanto.");
      const request = await ctx.workspace.createRequest({
        type: "dependencia",
        reason: motivo,
        roleProposal: null,
        question: null,
        toolNames: [],
        dependencia: { repoId: e.espacio.repoId, gestor, paquetes, dev: args.dev === true, carpeta: carpeta.relativa },
      });
      return ok(
        `Solicitud ${request.id} enviada: ${argvATexto(argvDeInstalacion(gestor, paquetes, { dev: args.dev === true }))} en ${e.espacio.nombre}${carpeta.relativa ? `/${carpeta.relativa}` : ""}. ` +
          `Cuando se apruebe se instala sola y te llega el resultado. No la esperes: seguí con lo que no dependa de eso.`,
      );
    },
  };

  const servicios: RegisteredTool = {
    name: "servicios",
    description:
      "Los servicios del repo (backend, frontend, app móvil, documentación): si están levantados y en qué URL, o las últimas líneas de su salida (accion='logs'). Los levanta una persona desde la pestaña Código; con un servicio levantado, lo que editás se recarga solo, así que después de un cambio mirá sus logs para ver si compiló.",
    inputSchema: {
      type: "object",
      properties: {
        accion: { type: "string", enum: ["listar", "logs"], description: "Default: listar." },
        servicio: { type: "string", description: "Id del servicio (ej. 'backend'). Para logs." },
        lineas: { type: "number", description: "Cuántas líneas de logs (default 80, máx. 400)." },
        ...REPO,
      },
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const lista = await storage.servicios(e.espacio.repoId);
      if (args.accion === "logs") {
        const id = String(args.servicio ?? "").trim();
        if (!id) return fail(`Falta 'servicio'. Hay: ${lista.map((s) => s.id).join(", ") || "ninguno"}.`);
        const lineas = Math.max(10, Math.min(400, Number(args.lineas ?? 80) || 80));
        const logs = await storage.logsDeServicio(e.espacio.repoId, id, lineas);
        return logs.ok ? ok(logs.texto || "(sin salida todavía)") : fail(logs.motivo);
      }
      if (lista.length === 0) {
        return ok("El repo no tiene servicios detectados. Si hay algo para levantar, lo configura una persona desde la pestaña Código.");
      }
      return ok(lista.map((s) => `- ${lineaDeServicio(s)}`).join("\n"));
    },
  };

  const probarServicio: RegisteredTool = {
    name: "probar_servicio",
    description:
      "Hace un pedido HTTP a un servicio levantado del repo (ej. GET /health al backend) y devuelve estado, cabeceras y cuerpo. Sirve para verificar que un cambio en la API responde como esperás. Sólo le habla a los servicios del repo, no a internet.",
    inputSchema: {
      type: "object",
      properties: {
        servicio: { type: "string", description: "Id del servicio (ej. 'backend')." },
        metodo: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], description: "Default GET." },
        ruta: { type: "string", description: "Ruta con query, ej. '/health' o '/api/projects?limit=5'." },
        cuerpo: { type: "string", description: "Cuerpo del pedido (JSON como texto)." },
        cabeceras: { type: "object", additionalProperties: { type: "string" }, description: "Cabeceras extra." },
        ...REPO,
      },
      required: ["servicio", "ruta"],
      additionalProperties: false,
    },
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    async execute(args, ctx) {
      const e = await espacioO(storage, args, ctx);
      if (!e.ok) return e.resultado;
      const ruta = String(args.ruta ?? "").trim();
      if (!ruta.startsWith("/")) return fail("La 'ruta' empieza con /, ej. '/health'. Sólo la ruta: el servicio ya dice dónde está.");
      const cabeceras =
        args.cabeceras && typeof args.cabeceras === "object"
          ? Object.fromEntries(Object.entries(args.cabeceras as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined;
      const r = await storage.probarServicio(e.espacio.repoId, String(args.servicio ?? "").trim(), {
        metodo: String(args.metodo ?? "GET").toUpperCase(),
        ruta,
        ...(typeof args.cuerpo === "string" ? { cuerpo: args.cuerpo } : {}),
        ...(cabeceras ? { cabeceras } : {}),
      });
      if (!r.ok) return fail(r.motivo);
      const { respuesta } = r;
      const tipo = respuesta.cabeceras["content-type"] ?? "";
      return ok(
        `${String(args.metodo ?? "GET").toUpperCase()} ${ruta} → ${respuesta.estado} · ${respuesta.ms} ms${tipo ? ` · ${tipo}` : ""}\n\n${respuesta.cuerpo || "(sin cuerpo)"}`,
        `HTTP ${respuesta.estado}`,
      );
    },
  };

  return [servicios, probarServicio, crearRepositorio, instalar, listarRepositorios, mapa, buscarCodigo, buscarArchivos, leer, editar, escribir, parche, estado, revertir, ejecutar, solicitar];
}
