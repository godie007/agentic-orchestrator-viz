import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { segmentoLegible } from "@orq/shared";

/**
 * Dónde vive en disco cada cosa de un proyecto. Una sola fuente de rutas.
 *
 * ```
 * <raíz>/<Nombre legible>/     ← marca `.empresa` con el id
 *   salida/                     ← lo que producen los agentes (antes data/exports/<id>)
 *   repos/<repo>/               ← clon gestionado del código que cargó una persona
 *   worktrees/<repo>/<rama>/    ← donde trabajan los agentes
 *   tmp/                        ← TMPDIR de los comandos y logs completos
 * ```
 *
 * Antes cada store decidía por su cuenta: la salida por id
 * (`data/exports/cmp_msw30yi82fdt1e`), el vault por nombre, y lo que no tenía
 * dueño quedaba donde cayera. Una persona que abría `data/` no podía decir qué
 * carpeta era de qué proyecto, y el borrado de una empresa limpiaba una de las
 * tres.
 *
 * **La carpeta se encuentra por la marca, no por el nombre.** El nombre es para
 * leer; el id manda. Así renombrar un proyecto no le crea una carpeta nueva al
 * lado de la vieja —que es lo que le pasa al vault—, y dos proyectos que se
 * llaman igual no mezclan sus archivos: el segundo toma `Nombre (abc123)`.
 *
 * **Consultar no crea.** Todo lo que empieza con `ruta`/`salida`/`repos`
 * devuelve dónde está o *estaría* la carpeta sin tocar el disco; sólo
 * `asegurar` escribe. Es la lección de `ExportStore.dirFor`: un barrido de
 * residuos que crea al pasar produce los residuos que viene a buscar.
 */

/** Archivo oculto que dice de qué proyecto es una carpeta. */
export const MARCA_PROYECTO = ".empresa";

export type Subcarpeta = "salida" | "repos" | "worktrees" | "tmp";

export class Directorios {
  /** id → carpeta del proyecto. Se invalida si la marca deja de coincidir. */
  private readonly cache = new Map<string, string>();

  constructor(
    readonly raiz: string,
    /** El nombre actual del proyecto, o `null` si ya no existe. */
    private readonly nombreDe: (companyId: string) => string | null,
  ) {}

  /** De quién es una carpeta de primer nivel, según su marca. */
  duenioDe(carpeta: string): string | null {
    try {
      return readFileSync(join(this.raiz, carpeta, MARCA_PROYECTO), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /** La carpeta marcada con este id, si existe. No crea nada. */
  private buscarMarcada(companyId: string): string | null {
    const enCache = this.cache.get(companyId);
    if (enCache && this.duenioDe(nombreBase(enCache)) === companyId) return enCache;
    this.cache.delete(companyId);

    let entradas: string[];
    try {
      entradas = readdirSync(this.raiz, { withFileTypes: true })
        .filter((entrada) => entrada.isDirectory())
        .map((entrada) => entrada.name);
    } catch {
      return null;
    }
    for (const nombre of entradas) {
      if (this.duenioDe(nombre) === companyId) {
        const dir = join(this.raiz, nombre);
        this.cache.set(companyId, dir);
        return dir;
      }
    }
    return null;
  }

  /**
   * El nombre de carpeta que le tocaría a un proyecto nuevo.
   *
   * Una carpeta existente **sin** marca tampoco se reclama: en esta raíz no
   * debería haber nada que no sea de un proyecto, y adueñarse de algo que
   * alguien dejó a mano es la forma de mezclarle archivos.
   */
  private nombreLibre(companyId: string): string {
    const base = segmentoLegible(this.nombreDe(companyId) ?? "") || companyId;
    for (const candidato of [base, `${base} (${companyId.slice(-6)})`]) {
      if (!existsSync(join(this.raiz, candidato))) return candidato;
    }
    return companyId;
  }

  /** La carpeta del proyecto, exista o no. No crea nada. */
  ruta(companyId: string): string {
    return this.buscarMarcada(companyId) ?? join(this.raiz, this.nombreLibre(companyId));
  }

  /**
   * Un `package.json` neutro en la raíz de los proyectos, para que Node no
   * mire más arriba.
   *
   * `data/` vive adentro del repo del orquestador, cuyo `package.json` dice
   * `"type": "module"`, y Node decide cómo cargar un `.js` por el
   * `package.json` más cercano. Todo lo que corre en los proyectos —un repo
   * sin `package.json` en la raíz, un archivo que una herramienta escribe en
   * el temporal— heredaba ese ESM: `ts-node-dev` escribe su hook en `TMPDIR`
   * y lo carga con `require`, y el backend de INSPIA moría en la línea uno con
   * "require is not defined". En la máquina de la persona el temporal está en
   * `/var/folders`, sin nada arriba, y por eso ahí andaba.
   */
  prepararRaiz(): void {
    const archivo = join(this.raiz, "package.json");
    if (existsSync(archivo)) return;
    mkdirSync(this.raiz, { recursive: true });
    writeFileSync(archivo, `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`, "utf8");
  }

  /** La carpeta del proyecto, creada y marcada si hacía falta. */
  asegurar(companyId: string): string {
    this.prepararRaiz();
    const existente = this.buscarMarcada(companyId);
    if (existente) return existente;
    const dir = join(this.raiz, this.nombreLibre(companyId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARCA_PROYECTO), companyId, "utf8");
    this.cache.set(companyId, dir);
    return dir;
  }

  /**
   * Muda la carpeta del proyecto al nombre que tiene ahora.
   *
   * La marca hace que un renombre no *necesite* mudar nada —la carpeta se sigue
   * encontrando—, pero una persona que abre `data/proyectos/` lee nombres, y
   * una carpeta que dice "Prueba 3" para el proyecto "Simulador" es la misma
   * confusión que el layout por id venía a sacar. Devuelve de dónde a dónde se
   * movió, o `null` si no había nada que mover: quien llama tiene que arreglar
   * lo que guardaba rutas absolutas (worktrees de git, servidores MCP).
   */
  mudar(companyId: string): { vieja: string; nueva: string } | null {
    const actual = this.buscarMarcada(companyId);
    if (!actual) return null;
    const base = segmentoLegible(this.nombreDe(companyId) ?? "") || companyId;
    const actualNombre = nombreBase(actual);
    if (actualNombre === base || actualNombre === `${base} (${companyId.slice(-6)})`) return null;

    // En un disco que no distingue mayúsculas (el de macOS por default),
    // "simulador" → "Simulador" es la misma carpeta: `existsSync` diría que el
    // destino está ocupado y le pondría sufijo sin motivo.
    const destino =
      actualNombre.toLowerCase() === base.toLowerCase() ? base : this.nombreLibre(companyId);
    if (destino === actualNombre) return null;
    const nueva = join(this.raiz, destino);
    renameSync(actual, nueva);
    this.cache.set(companyId, nueva);
    return { vieja: actual, nueva };
  }

  /** Una subcarpeta del proyecto. Sin `crear` no toca el disco. */
  sub(companyId: string, cual: Subcarpeta, crear = false): string {
    const base = crear ? this.asegurar(companyId) : this.ruta(companyId);
    const dir = join(base, cual);
    if (crear) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** ¿Esta ruta absoluta cae adentro del proyecto? Para verificar, nunca para armar. */
  contiene(companyId: string, absoluta: string): boolean {
    const base = resolve(this.ruta(companyId));
    const destino = resolve(absoluta);
    return destino === base || destino.startsWith(base + sep);
  }

  /** Carpetas de primer nivel, con su dueño según la marca. */
  carpetas(): Array<{ carpeta: string; duenio: string | null }> {
    try {
      return readdirSync(this.raiz, { withFileTypes: true })
        .filter((entrada) => entrada.isDirectory() && !entrada.name.startsWith("."))
        .map((entrada) => ({ carpeta: entrada.name, duenio: this.duenioDe(entrada.name) }));
    } catch {
      return [];
    }
  }

  olvidar(companyId: string): void {
    this.cache.delete(companyId);
  }
}

function nombreBase(ruta: string): string {
  return ruta.split(sep).at(-1) ?? ruta;
}

// --- Migración del layout viejo -------------------------------------------

/** Lo mínimo de un servidor MCP que hace falta para reescribir sus rutas. */
interface McpConRutas {
  transport:
    | { type: "stdio"; command: string; args: string[]; envRefs: Record<string, string>; cwd: string | null }
    | { type: "http"; url: string; headerRefs: Record<string, string>; caPath: string | null };
}

export interface CambioDeRuta {
  viejaAbs: string;
  nuevaAbs: string;
  viejaRel: string;
  nuevaRel: string;
}

/**
 * Reescribe en un transporte stdio las menciones a una carpeta que se mudó.
 *
 * Un servidor MCP puede tener la salida vieja metida en sus argumentos —el
 * Playwright de reconocimiento arranca con `--output-dir
 * ./data/exports/cmp_…/reconocimiento`—, y mudar la carpeta sin tocarlo lo
 * deja escribiendo en una ruta que ya no existe, o peor, recreándola. Se
 * reemplaza la forma absoluta y la relativa a la raíz del repo, que son las
 * dos que aparecen en la práctica. Devuelve `null` si no había nada que cambiar.
 */
export function reescribirRutasMcp<T extends McpConRutas>(server: T, cambio: CambioDeRuta): T | null {
  if (server.transport.type !== "stdio") return null;
  const reemplazar = (valor: string): string =>
    valor.split(cambio.viejaAbs).join(cambio.nuevaAbs).split(cambio.viejaRel).join(cambio.nuevaRel);
  const originales = server.transport.args;
  const args = originales.map(reemplazar);
  const cwd = server.transport.cwd === null ? null : reemplazar(server.transport.cwd);
  if (cwd === server.transport.cwd && args.every((arg, i) => arg === originales[i])) return null;
  return { ...server, transport: { ...server.transport, args, cwd } };
}

export interface ResultadoMigracion {
  /** Empresas cuya salida se mudó, con su carpeta nueva. */
  movidas: Array<{ companyId: string; destino: string }>;
  /** Servidores MCP a los que se les reescribió una ruta. */
  mcpReescritos: number;
  /** Carpetas del layout viejo que no son de ninguna empresa viva: quedan donde están. */
  sinEmpresa: string[];
  /** Empresas con salida en los dos layouts: no se mezclan solas. */
  enConflicto: string[];
}

/**
 * Muda la salida de `data/exports/<id>` a `<proyecto>/salida`.
 *
 * Idempotente: una empresa ya mudada no tiene carpeta vieja y se saltea. Si
 * existen las dos —alguien copió a mano, o una migración a medias— no se
 * fusionan solas: se informa y se deja para una persona, porque mezclar dos
 * árboles de entregables es la clase de cosa que no se deshace.
 */
export function migrarSalidasViejas(opciones: {
  exportsDir: string;
  repoRoot: string;
  directorios: Directorios;
  companyIds: string[];
  segmentoDe: (companyId: string) => string;
  servidoresMcp: (companyId: string) => McpConRutas[];
  guardarMcp: (server: McpConRutas) => void;
}): ResultadoMigracion {
  const resultado: ResultadoMigracion = { movidas: [], mcpReescritos: 0, sinEmpresa: [], enConflicto: [] };
  if (resolve(opciones.exportsDir) === resolve(opciones.directorios.raiz)) return resultado;

  const conocidas = new Set<string>();
  for (const companyId of opciones.companyIds) {
    const segmento = opciones.segmentoDe(companyId);
    conocidas.add(segmento);
    const vieja = join(opciones.exportsDir, segmento);
    if (!existsSync(vieja)) continue;

    const nueva = opciones.directorios.sub(companyId, "salida");
    if (existsSync(nueva)) {
      resultado.enConflicto.push(companyId);
      continue;
    }
    opciones.directorios.asegurar(companyId);
    renameSync(vieja, nueva);
    resultado.movidas.push({ companyId, destino: nueva });

    const cambio: CambioDeRuta = {
      viejaAbs: vieja,
      nuevaAbs: nueva,
      viejaRel: relative(opciones.repoRoot, vieja),
      nuevaRel: relative(opciones.repoRoot, nueva),
    };
    for (const server of opciones.servidoresMcp(companyId)) {
      const reescrito = reescribirRutasMcp(server, cambio);
      if (reescrito) {
        opciones.guardarMcp(reescrito);
        resultado.mcpReescritos += 1;
      }
    }
  }

  try {
    for (const entrada of readdirSync(opciones.exportsDir, { withFileTypes: true })) {
      if (entrada.isDirectory() && !conocidas.has(entrada.name)) resultado.sinEmpresa.push(entrada.name);
    }
  } catch {
    // Sin layout viejo: nada que informar.
  }
  return resultado;
}
