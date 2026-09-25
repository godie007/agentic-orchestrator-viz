import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  argvATexto,
  argvDeArranque,
  clasificarServicio,
  conIdsUnicos,
  esClaveSecreta,
  expandirUrls,
  parsearDotenv,
  redirigirUrlsLocales,
  type CarpetaCandidata,
  type PaqueteNode,
  type Redireccion,
  type Servicio,
} from "@orq/shared";
import { ejecutarComando, entornoDeServicio, perfilSandbox, type PedidoHttp, type RespuestaHttp } from "@orq/tools";
import { levantarProxyDeVista, type ProxyDeVista } from "./proxy-vista.js";

/**
 * Los servicios de un repo, levantados para la vista previa.
 *
 * Un repo como el de INSPIA tiene cuatro programas adentro —API, frontend,
 * app móvil, documentación— y la vista previa de archivos estáticos sólo
 * servía para el primero de los simuladores: una app de Vite o de Expo hay que
 * **levantarla**. Esto es lo que hace `npm run dev` en la terminal de la
 * persona, con cuatro diferencias que no son de gusto:
 *
 * - **Corre sobre el worktree de la sesión**, no sobre la carpeta de ella: lo
 *   que se ve es lo que cambiaron los agentes, y como Vite y `ts-node-dev`
 *   recargan solos, cada edición aparece sin que nadie reinicie nada.
 * - **Puerto propio** (`PUERTOS`), porque el 3001 y el 5173 los está usando
 *   ella con su versión. Y por eso las URLs a `localhost` de los `.env` se
 *   reescriben (`redirigirUrlsLocales`): si no, el frontend de la sesión le
 *   hablaría al backend de la persona.
 * - **Adentro del sandbox** de los comandos: lo que se levanta es código que
 *   editó un agente.
 * - **Los `.env` se leen al arrancar y se inyectan**: el clon los excluye, y
 *   copiarlos al worktree los dejaría al alcance de `leer_codigo`.
 *
 * Los procesos son del servidor y mueren con él. Como van en su propio grupo
 * (para poder matar a los nietos), un reinicio de `tsx watch` los dejaría
 * huérfanos ocupando puertos: se anotan en un archivo y se barren al arrancar.
 */

export const PUERTOS = { desde: 4300, hasta: 4399 } as const;
/**
 * Donde escuchan de verdad los frontends: su puerto público (el de `PUERTOS`)
 * lo atiende el proxy que les inyecta el selector de elementos. Ver
 * `proxy-vista.ts`.
 */
export const PUERTOS_INTERNOS = { desde: 4400, hasta: 4499 } as const;
const MAX_LINEAS = 3_000;
const ESPERA_LISTO_MS = 4 * 60_000;
const CORTE_PREPARAR_MS = 15 * 60_000;

export type EstadoServicio = "detenido" | "preparando" | "arrancando" | "listo" | "fallo";

export interface VistaDeServicio {
  servicioId: string;
  estado: EstadoServicio;
  puerto: number | null;
  url: string | null;
  desde: number | null;
  detalle: string | null;
  redirecciones: Redireccion[];
  externas: Array<{ clave: string; valor: string }>;
  /** Nombres de las variables inyectadas (nunca los valores). */
  variables: string[];
  comando: string | null;
}

interface Vivo {
  repoId: string;
  companyId: string;
  servicioId: string;
  estado: EstadoServicio;
  puerto: number | null;
  url: string | null;
  desde: number | null;
  detalle: string | null;
  hijo: ChildProcess | null;
  /** El proxy del selector, en los frontends. */
  proxy: ProxyDeVista | null;
  /** Donde escucha el programa detrás del proxy; igual a `puerto` si no hay proxy. */
  puertoInterno: number | null;
  detenidoAPedido: boolean;
  lineas: string[];
  /** Cuántas líneas entraron en total: la UI pide "desde la N" y no se pierde nada al rotar. */
  total: number;
  redirecciones: Redireccion[];
  externas: Array<{ clave: string; valor: string }>;
  variables: string[];
  /** Valores de variables secretas: se tapan en los logs y en las respuestas. */
  secretos: string[];
  comando: string | null;
}

export interface EntornoDeArranque {
  companyId: string;
  repoId: string;
  servicio: Servicio;
  /** Todos los servicios del repo: para saber a quién redirigir. */
  hermanos: Servicio[];
  /** Raíz real del worktree de la sesión. */
  dir: string;
  /** Carpeta de la persona para esta parte del repo, si el origen es local. */
  origen: string | null;
  tmp: string;
  /** `null` = sin sandbox (opt-in de la persona en el repo). */
  aislamiento: { escribibles: string[]; noEscribibles: string[] } | null;
}

const clave = (repoId: string, servicioId: string) => `${repoId}\u0000${servicioId}`;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export class ServiciosVivos {
  private readonly vivos = new Map<string, Vivo>();
  /** El último puerto de cada servicio: reusarlo mantiene estables las URLs (y las redirecciones). */
  private readonly puertos = new Map<string, number>();

  constructor(
    /** Dónde se anotan los procesos lanzados, para barrerlos si el servidor muere. */
    private readonly archivoPids: string,
    private readonly avisar: (evento: { companyId: string; repoId: string; servicioId: string; estado: EstadoServicio }) => void = () => {},
  ) {}

  // --- Consulta ---------------------------------------------------------------

  vista(repoId: string, servicioId: string): VistaDeServicio {
    const vivo = this.vivos.get(clave(repoId, servicioId));
    return {
      servicioId,
      estado: vivo?.estado ?? "detenido",
      puerto: vivo?.puerto ?? null,
      url: vivo?.estado === "listo" || vivo?.estado === "arrancando" ? vivo.url : null,
      desde: vivo?.desde ?? null,
      detalle: vivo?.detalle ?? null,
      redirecciones: vivo?.redirecciones ?? [],
      externas: vivo?.externas ?? [],
      variables: vivo?.variables ?? [],
      comando: vivo?.comando ?? null,
    };
  }

  hayVivos(filtro: { repoId?: string; companyId?: string }): boolean {
    return [...this.vivos.values()].some(
      (v) =>
        (v.estado === "arrancando" || v.estado === "listo" || v.estado === "preparando") &&
        (!filtro.repoId || v.repoId === filtro.repoId) &&
        (!filtro.companyId || v.companyId === filtro.companyId),
    );
  }

  /** Las líneas nuevas desde `desde` (un contador absoluto), con los secretos tapados. */
  lineasDesde(repoId: string, servicioId: string, desde: number): { lineas: string[]; siguiente: number } {
    const vivo = this.vivos.get(clave(repoId, servicioId));
    if (!vivo) return { lineas: [], siguiente: 0 };
    const primera = vivo.total - vivo.lineas.length;
    const inicio = Math.max(0, desde - primera);
    return { lineas: vivo.lineas.slice(inicio).map((l) => this.tapar(vivo, l)), siguiente: vivo.total };
  }

  ultimas(repoId: string, servicioId: string, cantidad: number): string | null {
    const vivo = this.vivos.get(clave(repoId, servicioId));
    if (!vivo) return null;
    return vivo.lineas
      .slice(-cantidad)
      .map((l) => this.tapar(vivo, l))
      .join("\n");
  }

  private tapar(vivo: Vivo, texto: string): string {
    let salida = texto;
    for (const secreto of vivo.secretos) salida = salida.split(secreto).join("«secreto»");
    return salida;
  }

  // --- Preparar -----------------------------------------------------------------

  /**
   * Deja las dependencias del servicio instaladas en el worktree.
   *
   * Si la persona ya las tiene instaladas y su lockfile es **el mismo** que el
   * de la sesión, se copian con `cp -c`: en APFS es un clon copy-on-write,
   * instantáneo y sin ocupar disco, y es exactamente lo que ella corre todos
   * los días (con sus scripts de instalación ya corridos, que acá no se
   * correrían). Si no, `npm ci --ignore-scripts` en el sandbox, con red.
   */
  async preparar(e: EntornoDeArranque): Promise<void> {
    const k = clave(e.repoId, e.servicio.id);
    const vivo = this.asegurar(e);
    if (vivo.estado === "preparando" || vivo.estado === "arrancando" || vivo.estado === "listo") {
      throw new Error(`${e.servicio.nombre} está ${vivo.estado}.`);
    }
    const dir = join(e.dir, e.servicio.carpeta);
    if (!existsSync(join(dir, "package.json"))) {
      throw new Error(`${e.servicio.nombre} no tiene package.json: no hay dependencias que preparar.`);
    }
    this.cambiar(vivo, { estado: "preparando", detalle: null, desde: Date.now() });
    try {
      if (existsSync(join(dir, "node_modules"))) {
        this.linea(k, "Las dependencias ya están en la sesión.");
      } else if (e.origen && (await mismoLockfile(e.origen, dir)) && existsSync(join(e.origen, "node_modules"))) {
        this.linea(k, `Copiando node_modules de ${e.origen} (clon copy-on-write: el lockfile es el mismo)…`);
        await copiarModulos(join(e.origen, "node_modules"), join(dir, "node_modules"));
        this.linea(k, "Listo.");
      } else {
        const argv = argvDeInstalacionLimpia(dir);
        this.linea(k, `$ ${argvATexto(argv)}`);
        const resultado = await ejecutarComando({
          argv,
          cwd: dir,
          tmpDir: join(e.tmp, "run"),
          corteMs: CORTE_PREPARAR_MS,
          aislamiento: e.aislamiento ? { tipo: "sandbox", ...e.aislamiento } : { tipo: "ninguno" },
        });
        for (const l of (resultado.error ?? resultado.salida).split("\n")) this.linea(k, l);
        if (resultado.error || resultado.cortadoPorTiempo || resultado.codigo !== 0) {
          throw new Error(`La instalación terminó con ${resultado.error ?? (resultado.cortadoPorTiempo ? "corte por tiempo" : `código ${resultado.codigo}`)}.`);
        }
      }
      this.cambiar(vivo, { estado: "detenido", detalle: null });
    } catch (error) {
      this.cambiar(vivo, { estado: "fallo", detalle: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // --- Arrancar / detener ------------------------------------------------------

  async arrancar(e: EntornoDeArranque): Promise<VistaDeServicio> {
    const { servicio } = e;
    const k = clave(e.repoId, servicio.id);
    const vivo = this.asegurar(e);
    if (vivo.estado === "arrancando" || vivo.estado === "listo") return this.vista(e.repoId, servicio.id);
    if (vivo.estado === "preparando") throw new Error(`${servicio.nombre} se está preparando.`);
    if (!servicio.arrancar) throw new Error(`${servicio.nombre} no se levanta: es ${servicio.tipo === "docs" ? "documentación, se lee" : "un servicio sin comando de arranque"}.`);
    const dir = join(e.dir, servicio.carpeta);
    if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
      throw new Error(`Faltan las dependencias de ${servicio.nombre}: preparalo primero.`);
    }

    const puerto = await this.puertoPara(k);
    const url = `http://127.0.0.1:${puerto}`;

    // Las URLs de los otros servicios —y la propia—: del puerto de la máquina
    // de la persona a la URL de acá. Se reserva el puerto de cada hermano
    // **aunque no esté levantado**, porque la dependencia es circular: el CORS
    // del backend (`FRONTEND_URL`) necesita la URL del frontend y el frontend
    // la del backend. Redirigir sólo a lo que ya corre obligaba a un orden de
    // arranque que no existe.
    const destinos = new Map<number, string>();
    const urls = new Map<string, string>();
    for (const hermano of e.hermanos) {
      if (!hermano.arrancar) continue;
      const suyo = hermano.id === servicio.id ? puerto : await this.puertoPara(clave(e.repoId, hermano.id));
      const suyaUrl = `http://127.0.0.1:${suyo}`;
      urls.set(hermano.id, suyaUrl);
      if (hermano.puertoOriginal) destinos.set(hermano.puertoOriginal, suyaUrl);
    }

    const leidas: Record<string, string> = {};
    for (const archivo of servicio.archivosEntorno) {
      try {
        Object.assign(leidas, parsearDotenv(await readFile(archivo, "utf8")));
      } catch {
        this.linea(k, `⚠ No se pudo leer ${archivo}: se arranca sin esas variables.`);
      }
    }
    const redirigido = redirigirUrlsLocales(leidas, destinos);
    const propias: Record<string, string> = { ...redirigido.variables };
    for (const [nombre, valor] of Object.entries(servicio.entorno)) {
      const expandido = expandirUrls(valor, urls);
      // Lo que pisa una variable extra ya lo decidió la persona: se muestra
      // como redirección y deja de avisarse como "apunta afuera".
      if (leidas[nombre] !== undefined && leidas[nombre] !== expandido && !esClaveSecreta(nombre)) {
        redirigido.redirecciones = [
          ...redirigido.redirecciones.filter((r) => r.clave !== nombre),
          { clave: nombre, antes: leidas[nombre]!, despues: expandido },
        ];
      }
      redirigido.externas = redirigido.externas.filter((x) => x.clave !== nombre);
      propias[nombre] = expandido;
    }
    // Un frontend escucha en un puerto interno y el público lo atiende el
    // proxy que le inyecta el selector de elementos. Una API no lo necesita:
    // nadie señala adentro de un JSON.
    const conProxy = servicio.tipo === "web" || servicio.tipo === "movil";
    const puertoInterno = conProxy ? await puertoLibreEn(PUERTOS_INTERNOS, this.puertosInternosEnUso()) : puerto;
    if (servicio.variablePuerto) propias[servicio.variablePuerto] = String(puertoInterno);

    const argv = argvDeArranque(servicio, puertoInterno);
    const conSandbox = e.aislamiento != null;
    const [ejecutable, ...resto] = argv;
    if (!ejecutable) throw new Error("El comando de arranque está vacío.");

    vivo.lineas = [];
    vivo.total = 0;
    this.cambiar(vivo, {
      estado: "arrancando",
      puerto,
      url,
      desde: Date.now(),
      detalle: null,
      detenidoAPedido: false,
      redirecciones: redirigido.redirecciones,
      externas: redirigido.externas,
      variables: Object.keys(propias).sort(),
      secretos: Object.entries(propias)
        .filter(([nombre, valor]) => esClaveSecreta(nombre) && valor.length >= 8)
        .map(([, valor]) => valor),
      comando: argvATexto(argv),
    });
    this.linea(
      k,
      `$ ${argvATexto(argv)}   (${servicio.carpeta || "raíz"}, puerto ${puerto}${conProxy ? ` → ${puertoInterno}` : ""}${conSandbox ? ", en sandbox" : ", SIN aislamiento"})`,
    );
    vivo.puertoInterno = puertoInterno;
    if (conProxy) {
      try {
        vivo.proxy = await levantarProxyDeVista({ puerto, destino: puertoInterno });
      } catch (error) {
        this.cambiar(vivo, { estado: "fallo", detalle: `No se pudo abrir el puerto ${puerto}: ${(error as Error).message}` });
        throw error;
      }
    }
    for (const r of redirigido.redirecciones) this.linea(k, `↪ ${r.clave}: ${r.antes} → ${r.despues}`);
    for (const x of redirigido.externas) this.linea(k, `⚠ ${x.clave} apunta afuera: ${x.valor}`);

    // Un temporal por servicio, creado antes de lanzar: `ts-node-dev` hace un
    // `mkdtemp` ahí al arrancar y, si la carpeta no existe, muere en la línea uno.
    const tmpServicio = join(e.tmp, "servicios", servicio.id);
    await mkdir(tmpServicio, { recursive: true });
    const hijo = spawn(
      conSandbox ? "/usr/bin/sandbox-exec" : ejecutable,
      conSandbox ? ["-p", perfilSandbox(e.aislamiento!), ejecutable, ...resto] : resto,
      {
        cwd: dir,
        env: entornoDeServicio(process.env, tmpServicio, propias),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    vivo.hijo = hijo;
    this.anotarPid(hijo.pid);

    let resto_ = "";
    const recibir = (trozo: Buffer) => {
      const texto = (resto_ + trozo.toString("utf8")).replace(ANSI, "");
      const partes = texto.split(/\r?\n|\r/);
      resto_ = partes.pop() ?? "";
      for (const l of partes) this.linea(k, l);
    };
    hijo.stdout?.on("data", recibir);
    hijo.stderr?.on("data", recibir);
    hijo.on("error", (error) => {
      const noExiste = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.cambiar(vivo, { estado: "fallo", detalle: noExiste ? `No se encontró "${ejecutable}" en el PATH.` : error.message, hijo: null });
    });
    hijo.on("close", (codigo) => {
      if (resto_) this.linea(k, resto_);
      this.olvidarPid(hijo.pid);
      if (vivo.hijo !== hijo) return;
      matarGrupo(hijo.pid, "SIGKILL");
      vivo.proxy?.cerrar();
      vivo.proxy = null;
      this.cambiar(vivo, vivo.detenidoAPedido
        ? { estado: "detenido", hijo: null, url: null }
        : { estado: "fallo", hijo: null, url: null, detalle: `Terminó con código ${codigo ?? "?"}. Mirá el final de la salida.` });
    });

    // La salud se pide al programa directo, no al proxy: el proxy contesta
    // 502 mientras el programa arranca, y cualquier respuesta cuenta como lista.
    void this.esperarListo(vivo, hijo, `http://127.0.0.1:${puertoInterno}${servicio.salud ?? ""}`);
    return this.vista(e.repoId, servicio.id);
  }

  /** Cualquier respuesta HTTP es "listo": un 404 en `/` también es un servidor andando. */
  private async esperarListo(vivo: Vivo, hijo: ChildProcess, url: string): Promise<void> {
    const limite = Date.now() + ESPERA_LISTO_MS;
    while (Date.now() < limite && vivo.hijo === hijo && vivo.estado === "arrancando") {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
        await r.body?.cancel().catch(() => {});
        if (vivo.hijo === hijo && vivo.estado === "arrancando") {
          this.cambiar(vivo, { estado: "listo" });
          this.linea(clave(vivo.repoId, vivo.servicioId), `✓ Responde en ${vivo.url} (HTTP ${r.status}).`);
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (vivo.hijo === hijo && vivo.estado === "arrancando") {
      this.cambiar(vivo, { estado: "fallo", detalle: `No respondió en ${ESPERA_LISTO_MS / 60_000} minutos en ${url}.` });
    }
  }

  detener(repoId: string, servicioId: string): void {
    const vivo = this.vivos.get(clave(repoId, servicioId));
    if (!vivo?.hijo) {
      if (vivo && vivo.estado !== "preparando") this.cambiar(vivo, { estado: "detenido", url: null });
      return;
    }
    vivo.detenidoAPedido = true;
    vivo.proxy?.cerrar();
    vivo.proxy = null;
    const pid = vivo.hijo.pid;
    matarGrupo(pid, "SIGTERM");
    setTimeout(() => matarGrupo(pid, "SIGKILL"), 3_000).unref();
    this.cambiar(vivo, { estado: "detenido", url: null });
  }

  /** Antes de integrar, descartar o borrar: el worktree sobre el que corren se va. */
  detenerDelRepo(repoId: string): void {
    for (const v of this.vivos.values()) if (v.repoId === repoId) this.detener(v.repoId, v.servicioId);
  }

  detenerDeEmpresa(companyId: string): void {
    for (const v of this.vivos.values()) if (v.companyId === companyId) this.detener(v.repoId, v.servicioId);
  }

  /** Sincrónico, para el `exit` del proceso: ahí no se puede esperar nada. */
  detenerTodos(): void {
    for (const v of this.vivos.values()) {
      if (v.hijo?.pid) matarGrupo(v.hijo.pid, "SIGKILL");
      v.proxy?.cerrar();
    }
    try {
      writeFileSync(this.archivoPids, "[]");
    } catch {
      // sin archivo no hay nada que barrer después
    }
  }

  /**
   * Barre los procesos que quedaron de un servidor anterior. Se compara la
   * hora de inicio además del pid: un pid reciclado por otro programa no se
   * mata por parecerse.
   */
  async barrerHuerfanos(): Promise<number> {
    let anotados: Array<{ pid: number; inicio: string }> = [];
    try {
      anotados = JSON.parse(readFileSync(this.archivoPids, "utf8")) as typeof anotados;
    } catch {
      return 0;
    }
    let barridos = 0;
    for (const { pid, inicio } of anotados) {
      const actual = await inicioDeProceso(pid);
      if (actual && actual === inicio) {
        matarGrupo(pid, "SIGKILL");
        barridos += 1;
      }
    }
    try {
      writeFileSync(this.archivoPids, "[]");
    } catch {
      // ídem
    }
    return barridos;
  }

  // --- Probar -------------------------------------------------------------------

  async probar(repoId: string, servicioId: string, pedido: PedidoHttp): Promise<RespuestaHttp> {
    const vivo = this.vivos.get(clave(repoId, servicioId));
    if (!vivo || vivo.estado !== "listo" || !vivo.url) {
      throw new Error(`El servicio ${servicioId} no está levantado. Lo levanta una persona desde la pestaña Código.`);
    }
    if (!pedido.ruta.startsWith("/")) throw new Error("La ruta empieza con /.");
    const inicio = Date.now();
    const metodo = pedido.metodo.toUpperCase();
    const r = await fetch(vivo.url + pedido.ruta, {
      method: metodo,
      headers: {
        ...(pedido.cuerpo && !Object.keys(pedido.cabeceras ?? {}).some((c) => c.toLowerCase() === "content-type")
          ? { "content-type": "application/json" }
          : {}),
        ...(pedido.cabeceras ?? {}),
      },
      ...(pedido.cuerpo && metodo !== "GET" && metodo !== "HEAD" ? { body: pedido.cuerpo } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    let cuerpo = await r.text();
    const tipo = r.headers.get("content-type") ?? "";
    if (tipo.includes("json")) {
      try {
        cuerpo = JSON.stringify(JSON.parse(cuerpo), null, 2);
      } catch {
        // se muestra tal cual
      }
    }
    if (cuerpo.length > 8_000) cuerpo = `${cuerpo.slice(0, 8_000)}\n[… ${cuerpo.length - 8_000} caracteres más …]`;
    const cabeceras: Record<string, string> = {};
    r.headers.forEach((valor, nombre) => {
      if (!/^(set-cookie|authorization)$/i.test(nombre)) cabeceras[nombre] = valor;
    });
    return { estado: r.status, cabeceras, cuerpo: this.tapar(vivo, cuerpo), ms: Date.now() - inicio };
  }

  // --- Internos -----------------------------------------------------------------

  private asegurar(e: { repoId: string; companyId: string; servicio: Servicio }): Vivo {
    const k = clave(e.repoId, e.servicio.id);
    let vivo = this.vivos.get(k);
    if (!vivo) {
      vivo = {
        repoId: e.repoId,
        companyId: e.companyId,
        servicioId: e.servicio.id,
        estado: "detenido",
        puerto: null,
        url: null,
        desde: null,
        detalle: null,
        hijo: null,
        proxy: null,
        puertoInterno: null,
        detenidoAPedido: false,
        lineas: [],
        total: 0,
        redirecciones: [],
        externas: [],
        variables: [],
        secretos: [],
        comando: null,
      };
      this.vivos.set(k, vivo);
    }
    return vivo;
  }

  private cambiar(vivo: Vivo, cambios: Partial<Vivo>): void {
    const antes = vivo.estado;
    Object.assign(vivo, cambios);
    if (vivo.estado !== antes) {
      this.avisar({ companyId: vivo.companyId, repoId: vivo.repoId, servicioId: vivo.servicioId, estado: vivo.estado });
    }
  }

  private linea(k: string, texto: string): void {
    const vivo = this.vivos.get(k);
    if (!vivo) return;
    vivo.lineas.push(texto.length > 4_000 ? `${texto.slice(0, 4_000)}…` : texto);
    vivo.total += 1;
    if (vivo.lineas.length > MAX_LINEAS) vivo.lineas.splice(0, vivo.lineas.length - MAX_LINEAS);
  }

  /**
   * El puerto de un servicio: el que ya tenía (reservado o de la vez
   * anterior) si sigue libre, o el primero libre del rango que no esté
   * reservado para otro. Un hermano que ya corre no se vuelve a sondear: su
   * puerto está ocupado justamente por él.
   */
  private async puertoPara(k: string): Promise<number> {
    const corriendo = [...this.vivos.entries()].find(([clave_, v]) => clave_ === k && (v.estado === "listo" || v.estado === "arrancando"));
    if (corriendo?.[1].puerto) return corriendo[1].puerto;
    const enUso = new Set<number>([
      ...[...this.vivos.values()].map((v) => v.puerto).filter((p): p is number => p != null),
      ...[...this.puertos.entries()].filter(([otra]) => otra !== k).map(([, p]) => p),
    ]);
    const preferido = this.puertos.get(k);
    const candidatos = [
      ...(preferido ? [preferido] : []),
      ...Array.from({ length: PUERTOS.hasta - PUERTOS.desde + 1 }, (_, i) => PUERTOS.desde + i),
    ];
    for (const puerto of candidatos) {
      if (puerto !== preferido && enUso.has(puerto)) continue;
      if (await puertoLibre(puerto)) {
        this.puertos.set(k, puerto);
        return puerto;
      }
    }
    throw new Error(`No hay puertos libres entre ${PUERTOS.desde} y ${PUERTOS.hasta}.`);
  }

  private puertosInternosEnUso(): Set<number> {
    return new Set(
      [...this.vivos.values()]
        .filter((v) => v.hijo && v.puertoInterno != null && v.puertoInterno !== v.puerto)
        .map((v) => v.puertoInterno!),
    );
  }

  private leerPids(): Array<{ pid: number; inicio: string }> {
    try {
      return JSON.parse(readFileSync(this.archivoPids, "utf8")) as Array<{ pid: number; inicio: string }>;
    } catch {
      return [];
    }
  }

  private anotarPid(pid: number | undefined): void {
    if (!pid) return;
    void inicioDeProceso(pid).then((inicio) => {
      if (!inicio) return;
      try {
        writeFileSync(this.archivoPids, JSON.stringify([...this.leerPids().filter((p) => p.pid !== pid), { pid, inicio }]));
      } catch {
        // si no se puede anotar, un reinicio lo deja huérfano: no es motivo para no arrancar
      }
    });
  }

  private olvidarPid(pid: number | undefined): void {
    if (!pid) return;
    try {
      writeFileSync(this.archivoPids, JSON.stringify(this.leerPids().filter((p) => p.pid !== pid)));
    } catch {
      // ídem
    }
  }
}

function matarGrupo(pid: number | undefined, senal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, senal);
  } catch {
    try {
      process.kill(pid, senal);
    } catch {
      // ya no existe
    }
  }
}

function inicioDeProceso(pid: number): Promise<string | null> {
  return new Promise((resolver) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3_000 }, (error, stdout) => {
      resolver(error ? null : stdout.trim() || null);
    });
  });
}

async function puertoLibreEn(rango: { desde: number; hasta: number }, enUso: Set<number>): Promise<number> {
  for (let puerto = rango.desde; puerto <= rango.hasta; puerto++) {
    if (!enUso.has(puerto) && (await puertoLibre(puerto))) return puerto;
  }
  throw new Error(`No hay puertos libres entre ${rango.desde} y ${rango.hasta}.`);
}

function puertoLibre(puerto: number): Promise<boolean> {
  return new Promise((resolver) => {
    const servidor = createServer();
    servidor.once("error", () => resolver(false));
    servidor.once("listening", () => servidor.close(() => resolver(true)));
    servidor.listen(puerto, "127.0.0.1");
  });
}

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

async function mismoLockfile(origen: string, destino: string): Promise<boolean> {
  for (const archivo of LOCKFILES) {
    const a = join(origen, archivo);
    const b = join(destino, archivo);
    if (existsSync(a) || existsSync(b)) {
      try {
        return (await readFile(a, "utf8")) === (await readFile(b, "utf8"));
      } catch {
        return false;
      }
    }
  }
  return false;
}

function argvDeInstalacionLimpia(dir: string): string[] {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"];
  if (existsSync(join(dir, "yarn.lock"))) return ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"];
  if (existsSync(join(dir, "package-lock.json"))) return ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  return ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"];
}

/** `cp -cR`: clon copy-on-write en APFS. Donde no se puede, copia común. */
function copiarModulos(desde: string, hasta: string): Promise<void> {
  const args = process.platform === "darwin" ? ["-cR", desde, hasta] : ["-R", desde, hasta];
  return new Promise((resolver, rechazar) => {
    execFile("cp", args, { timeout: CORTE_PREPARAR_MS, maxBuffer: 1024 * 1024 }, (error) => {
      if (!error) return resolver();
      if (process.platform === "darwin") {
        // Un volumen que no es APFS no clona: se reintenta copiando.
        execFile("cp", ["-R", desde, hasta], { timeout: CORTE_PREPARAR_MS }, (otro) => (otro ? rechazar(otro) : resolver()));
      } else {
        rechazar(error);
      }
    });
  });
}

// --- Detección ------------------------------------------------------------------

const NO_ES_SERVICIO = new Set(["node_modules", "dist", "build", "coverage", "test-results", "tests", "test", "scripts", "public", "assets", "src", "lib", "deploy", "devops", "vendor", "tmp"]);
const CONTENEDORES = new Set(["apps", "packages", "services", "servicios"]);
const ARCHIVOS_ENTORNO = [".env", ".env.local", ".env.development", ".env.development.local"];

/**
 * Qué servicios hay en un repo: la raíz, las carpetas de primer nivel y las de
 * `apps/`, `packages/`, `services/`. Lee el checkout del clon (lo que está en
 * git) y, si el origen es local, los `.env` de la carpeta de la persona.
 */
export async function detectarServicios(dirRepo: string, origen: string | null): Promise<Servicio[]> {
  const carpetas: string[] = [""];
  for (const entrada of await leerDir(dirRepo)) {
    if (!entrada.isDirectory() || entrada.name.startsWith(".") || NO_ES_SERVICIO.has(entrada.name)) continue;
    if (CONTENEDORES.has(entrada.name)) {
      for (const hija of await leerDir(join(dirRepo, entrada.name))) {
        if (hija.isDirectory() && !hija.name.startsWith(".")) carpetas.push(`${entrada.name}/${hija.name}`);
      }
    } else {
      carpetas.push(entrada.name);
    }
  }
  const servicios: Servicio[] = [];
  for (const carpeta of carpetas) {
    const candidata = await leerCandidata(dirRepo, carpeta, origen);
    const servicio = clasificarServicio(candidata);
    if (servicio) servicios.push(servicio);
  }
  // Una raíz que es un servicio y además tiene servicios adentro no es un
  // monorepo: es una app con carpetas. Se queda la raíz.
  const raiz = servicios.find((s) => s.carpeta === "" && s.tipo !== "docs");
  let lista = raiz ? servicios.filter((s) => s === raiz || s.tipo === "docs") : servicios;
  // La raíz como documentación sólo si no hay una carpeta de notas propia: en
  // INSPIA el vault de Obsidian es el repo entero (`.obsidian` en la raíz)
  // pero las notas viven en `inspia-obsidian/`, y listar las dos es ofrecer
  // el README y el CLAUDE.md como si fueran la documentación.
  if (lista.some((s) => s.tipo === "docs" && s.carpeta !== "")) {
    lista = lista.filter((s) => !(s.tipo === "docs" && s.carpeta === ""));
  }
  return conIdsUnicos(lista.map((s) => (s.tipo === "docs" && s.carpeta === "" ? { ...s, id: "documentacion", nombre: "Documentación" } : s)));
}

async function leerDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function leerCandidata(dirRepo: string, carpeta: string, origen: string | null): Promise<CarpetaCandidata> {
  const dir = join(dirRepo, carpeta);
  let paquete: PaqueteNode | null = null;
  try {
    paquete = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PaqueteNode;
  } catch {
    paquete = null;
  }
  const dirOrigen = origen ? join(origen, carpeta) : null;
  const archivosEntorno = dirOrigen ? ARCHIVOS_ENTORNO.map((a) => join(dirOrigen, a)).filter((a) => existsSync(a)) : [];
  let puertoEnv: number | null = null;
  for (const archivo of archivosEntorno) {
    try {
      const puerto = Number(parsearDotenv(await readFile(archivo, "utf8"))["PORT"]);
      if (Number.isInteger(puerto) && puerto > 0) puertoEnv = puerto;
    } catch {
      // sin archivo, sin puerto
    }
  }
  return {
    carpeta,
    paquete,
    notas: await contarNotas(dir, 2),
    obsidian: existsSync(join(dir, ".obsidian")),
    puertoVite: await puertoDeVite(dir),
    puertoEnv,
    ...(paquete ? await pistasDelCodigo(dir) : {}),
    archivosEntorno,
  };
}

async function contarNotas(dir: string, profundidad: number): Promise<number> {
  let total = 0;
  for (const entrada of await leerDir(dir)) {
    if (entrada.name.startsWith(".") || entrada.name === "node_modules") continue;
    if (entrada.isFile() && entrada.name.toLowerCase().endsWith(".md")) total += 1;
    else if (entrada.isDirectory() && profundidad > 0) total += await contarNotas(join(dir, entrada.name), profundidad - 1);
    if (total > 200) break;
  }
  return total;
}

async function puertoDeVite(dir: string): Promise<number | null> {
  for (const nombre of ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]) {
    try {
      const texto = await readFile(join(dir, nombre), "utf8");
      const m = /server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/.exec(texto);
      return m ? Number(m[1]) : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** El puerto por default y la ruta de salud, buscados en el código del servidor. */
async function pistasDelCodigo(dir: string): Promise<{ puertoCodigo: number | null; salud: string | null }> {
  let puertoCodigo: number | null = null;
  let salud: string | null = null;
  const archivos: string[] = [];
  const recorrer = async (ruta: string, profundidad: number) => {
    for (const entrada of await leerDir(ruta)) {
      if (archivos.length > 400) return;
      if (entrada.name.startsWith(".") || entrada.name === "node_modules" || entrada.name === "dist") continue;
      const completa = join(ruta, entrada.name);
      if (entrada.isDirectory() && profundidad > 0) await recorrer(completa, profundidad - 1);
      else if (/\.(ts|js|mjs|cjs)$/.test(entrada.name) && !/\.(test|spec)\./.test(entrada.name)) archivos.push(completa);
    }
  };
  await recorrer(join(dir, "src"), 2);
  for (const nombre of ["server.js", "server.ts", "index.js", "index.ts", "app.js", "app.ts"]) archivos.push(join(dir, nombre));
  for (const archivo of archivos) {
    let texto: string;
    try {
      if ((await stat(archivo)).size > 400_000) continue;
      texto = await readFile(archivo, "utf8");
    } catch {
      continue;
    }
    puertoCodigo ??= Number(/process\.env\.PORT\)?\s*(?:\|\||\?\?)\s*(\d{2,5})/.exec(texto)?.[1]) || null;
    salud ??= /\.(?:get|all)\(\s*['"`](\/(?:api\/)?health(?:z|check)?)['"`]/.exec(texto)?.[1] ?? null;
    if (puertoCodigo && salud) break;
  }
  return { puertoCodigo, salud };
}
