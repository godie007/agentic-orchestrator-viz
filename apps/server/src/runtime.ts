import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  MEJORADOR_DE_CODIGO,
  argvATexto,
  argvDeInstalacion,
  validarPaquete,
  esCorridaTerminal,
  ids,
  companySchema,
  mcpServerSchema,
  plantillaEquipo,
  validarPrefijoPermitido,
} from "@orq/shared";
import type {
  AgentRequest,
  Company,
  CreateRunInput,
  Repositorio,
  SesionCodigo,
  Department,
  McpServer,
  McpServerHealth,
  ModelSelection,
  ProviderId,
  Role,
  RoleProposal,
  Run,
  Tool,
  TraceEvent,
} from "@orq/shared";
import { RunLedger, type ProviderRegistry } from "@orq/llm";
import {
  McpBridge,
  ToolRegistry,
  crearCorreo,
  crearToolCompuesta,
  createCrearHerramienta,
  createEmailTools,
  createSkillTools,
  crearHerramientasDeContexto,
  crearHerramientasDeCodigo,
  hayAislamiento,
  resolverEnWorktree,
  mapaDeContextoEnPrompt,
  type Correo,
} from "@orq/tools";
import { EventBus, Orchestrator, RunState, type CompanyConfig } from "@orq/engine";
import type { Store } from "./db.js";
import type { Env } from "./env.js";
import { repoRoot, resolveSecret } from "./env.js";
import { ExportStore, disposicionPorProyecto } from "./exports.js";
import {
  Directorios,
  migrarSalidasViejas,
  reescribirRutasMcp,
  type ResultadoMigracion,
} from "./directorios.js";
import { RepoStore, type EventoDeCodigo } from "./repos.js";
import { ServiciosVivos, type EntornoDeArranque, type VistaDeServicio } from "./servicios.js";
import { ControlDeVersiones } from "./scm.js";
import { crearFabricaOAuth, olvidarOAuth } from "./mcp-oauth.js";
import { git } from "./git.js";
import {
  ArriendosDeCodigo,
  abrirTurnoDeCodigo,
  crearCodigoStorage,
  espacioDePersona,
  HERRAMIENTAS_DE_CODIGO,
} from "./codigo-servidor.js";
import { ContextoStore, notaDeAprendizajes, rutaDeTema } from "./contexto.js";

/**
 * Runtime del servidor: mantiene lo que está vivo.
 *
 * Hay dos niveles. El **runtime de empresa** vive mientras el servidor esté
 * arriba y sostiene las conexiones MCP y el registro de herramientas — por eso
 * el MCP Hub puede mostrar servidores conectados aunque no haya ninguna corrida
 * en curso. La **corrida** es efímera y se apoya en él.
 */

export type EventSink = (event: TraceEvent) => void;

/**
 * Activa el escalado por dificultad sobre un modelo heredado, con el rango que
 * le corresponde a la autoridad: un executive puede subir hasta `smart`, un
 * executor no pasa de `standard`. Una empresa en tier `free` no escala a
 * modelos pagos —iría derecho a un 402—, y un slug fijo queda como está: el
 * slug tiene prioridad absoluta y el escalado sería letra muerta.
 */
export function conEscaladoPorAutoridad(
  base: ModelSelection,
  authority: Role["authority"],
): ModelSelection {
  if (base.tier === "free") {
    return { ...base, escalado: { activo: true, tierMinimo: "free", tierMaximo: "free" } };
  }
  const tierMaximo = authority === "executive" ? "smart" : "standard";
  const tierMinimo = authority === "executive" ? "standard" : "cheap";
  return { ...base, escalado: { activo: true, tierMinimo, tierMaximo } };
}

interface CompanyRuntime {
  companyId: string;
  tools: ToolRegistry;
  mcp: McpBridge;
  health: Map<string, McpServerHealth>;
}

interface ActiveRun {
  run: Run;
  state: RunState;
  bus: EventBus;
  ledger: RunLedger;
  orchestrator: Orchestrator;
  companyId: string;
}

export class Runtime {
  private companies = new Map<string, CompanyRuntime>();
  private runs = new Map<string, ActiveRun>();
  /** Suscriptores SSE por corrida, más los del canal global de MCP. */
  private runSubscribers = new Map<string, Set<EventSink>>();
  private mcpSubscribers = new Set<(health: McpServerHealth) => void>();
  /**
   * Suscriptores de lo que pasa con el código de una empresa fuera de toda
   * corrida: cargar un repo, integrar o descartar una sesión. La traza exige un
   * `runId`, y estas cosas las hace una persona sin corrida de por medio.
   */
  private codigoSubscribers = new Map<string, Set<(evento: EventoDeCodigo) => void>>();

  /** Documentos que producen las habilidades, uno por empresa. */
  readonly exports: ExportStore;

  /** Dónde vive en disco cada cosa de un proyecto. Ver `directorios.ts`. */
  readonly directorios: Directorios;

  /** El código cargado en cada proyecto y sus sesiones de trabajo. */
  readonly repos: RepoStore;

  /** Quién escribe en cada repo en este momento. Ver `ArriendosDeCodigo`. */
  private readonly arriendos = new ArriendosDeCodigo();

  /** Backend, frontend, app móvil: lo que está levantado para la vista previa. Ver `servicios.ts`. */
  readonly servicios: ServiciosVivos;

  /** Stage, commit, stash y ramas sobre la sesión, desde el IDE. Ver `scm.ts`. */
  readonly scm: ControlDeVersiones;

  /**
   * El árbol de contexto de cada empresa, como vault de Obsidian.
   *
   * Va por el filesystem y no por el plugin de Obsidian a propósito: así el
   * conocimiento del sistema no depende de que una aplicación de escritorio
   * esté abierta. Obsidian es el visor.
   */
  readonly contexto: ContextoStore;

  /** Salida de correo de todo el servidor. La comparten misiones y agentes. */
  readonly correo: Correo;

  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly env: Env,
  ) {
    this.directorios = new Directorios(env.proyectosDir, (id) => store.getCompany(id)?.name ?? null);
    this.exports = new ExportStore(disposicionPorProyecto(this.directorios));
    this.repos = new RepoStore(store, this.directorios, (evento) => this.broadcastCodigo(evento));
    this.servicios = new ServiciosVivos(join(env.proyectosDir, ".servicios-vivos.json"), (evento) =>
      this.broadcastCodigo({
        tipo: "servicio",
        companyId: evento.companyId,
        repoId: evento.repoId,
        detalle: `${evento.servicioId}: ${evento.estado}`,
        at: Date.now(),
      }),
    );
    this.contexto = new ContextoStore(env.contextoDir);
    this.scm = new ControlDeVersiones(this.repos);
    this.correo = crearCorreo({ webhookUrl: env.emailWebhookUrl });
  }

  /**
   * Muda la salida del layout viejo (`data/exports/<id>`) a la carpeta legible
   * de cada proyecto. Corre al arrancar, **antes** de levantar cualquier MCP:
   * un servidor que arranca con la ruta vieja en sus argumentos la volvería a
   * crear.
   */
  migrarLayout(): ResultadoMigracion {
    return migrarSalidasViejas({
      exportsDir: this.env.exportsDir,
      repoRoot,
      directorios: this.directorios,
      companyIds: this.store.listCompanies().map((company) => company.id),
      segmentoDe: (id) => ExportStore.safeSegment(id),
      servidoresMcp: (id) => this.store.listMcpServers(id),
      guardarMcp: (server) => this.store.saveMcpServer(mcpServerSchema.parse(server)),
    });
  }

  // --- Runtime de empresa (MCP + herramientas) -----------------------------

  /** Levanta (o devuelve) el runtime de una empresa y sincroniza sus MCP. */
  async companyRuntime(companyId: string): Promise<CompanyRuntime> {
    let runtime = this.companies.get(companyId);
    if (!runtime) {
      const tools = new ToolRegistry();
      // Las habilidades se registran por empresa porque escriben en su propio
      // directorio: cada una exporta a lo suyo y no ve los documentos de otra.
      for (const skill of createSkillTools(this.exports.forCompany(companyId), {
        musicaHome: this.env.musicaDir,
      })) {
        tools.register(skill);
      }
      // El árbol de contexto también es por empresa: cada una escribe en su
      // rama del vault y no ve la de las otras.
      // El nombre se resuelve al usar y no acá: si la empresa se renombra, la
      // carpeta del vault la sigue sin que haya que reiniciar el runtime.
      const empresaDeContexto = (): { id: string; nombre: string } => ({
        id: companyId,
        nombre: this.store.getCompany(companyId)?.name ?? companyId,
      });
      for (const tool of crearHerramientasDeContexto({
        escribir: (ruta, contenido) =>
          this.contexto.escribir(empresaDeContexto(), ruta, contenido),
        leer: (ruta) => this.contexto.leer(empresaDeContexto(), ruta),
        buscar: (texto) => this.contexto.buscar(empresaDeContexto(), texto),
        mapa: () => this.contexto.mapa(empresaDeContexto()),
      })) {
        tools.register(tool);
      }
      // El correo también se registra por empresa: el enlace de un adjunto
      // lleva el id de la empresa adentro, así que no puede ser una tool global.
      const base = this.env.apiUrl.replace(/\/$/, "");
      for (const email of createEmailTools(
        this.correo,
        (ruta) => `${base}/api/companies/${companyId}/exports/${ruta}`,
      )) {
        tools.register(email);
      }
      // Las herramientas compuestas que la empresa ya creó vuelven al catálogo
      // vivo: se persisten como cualquier otra, pero lo ejecutable se arma acá.
      // Una fila sin composición válida se saltea en vez de tumbar el runtime.
      for (const fila of this.store.listTools(companyId)) {
        if (fila.origin !== "creada" || !fila.composicion) continue;
        tools.register(crearToolCompuesta(fila, (name) => tools.get(name)));
      }
      // Y la capacidad de crear nuevas, que necesita el catálogo de esta
      // empresa a mano: por eso se registra acá y no entre las de coordinación
      // globales.
      tools.register(
        createCrearHerramienta({
          registrar: (creada) => tools.register(creada),
          resolver: (name) => tools.get(name),
        }),
      );
      // Las de código, sólo si el proyecto tiene un repo: una herramienta que no
      // se puede cumplir hace gastar turnos intentándola.
      this.registrarCodigoEn(tools, companyId);
      const health = new Map<string, McpServerHealth>();
      const mcp = new McpBridge(
        tools,
        resolveSecret,
        (update) => {
          health.set(update.serverId, update);
          this.broadcastMcp(update);
          this.persistMcpTools(companyId, tools);
          if (update.status === "ready") this.otorgarAlConectar(companyId, update.serverId);
        },
        this.fabricaOAuth,
      );
      runtime = { companyId, tools, mcp, health };
      this.companies.set(companyId, runtime);
    }
    await runtime.mcp.sync(this.store.listMcpServers(companyId));
    return runtime;
  }

  private depsDeCodigo(companyId: string) {
    return {
      store: this.store,
      repos: this.repos,
      directorios: this.directorios,
      arriendos: this.arriendos,
      servicios: this.servicios,
      companyId,
      emitirCheckpoint: (
        runId: string,
        evento: { roleId: string; repoId: string; rama: string; sha: string; mensaje: string; archivos: number; antes?: string; commit?: boolean },
      ) => {
        const activa = this.runs.get(runId);
        activa?.bus.emit({ type: "codigo.checkpoint", runId, tick: activa.state.tick, ...evento });
      },
    };
  }

  /**
   * Las herramientas de código se registran **aunque todavía no haya repo**.
   *
   * Es la excepción consciente a "la que no se puede cumplir no se registra":
   * un proyecto nace de una plantilla antes de que alguien cargue su código, y
   * `generarEquipo` sólo puede otorgar lo que está en el catálogo. Sin repo, el
   * espacio de código del turno no se abre —el agente no las ve en su resumen—
   * y cada una contesta qué falta y quién lo carga, que es un aviso y no un
   * intento fallido que se repite.
   */
  private registrarCodigoEn(tools: ToolRegistry, companyId: string): void {
    for (const nombre of HERRAMIENTAS_DE_CODIGO) tools.unregister(nombre);
    for (const tool of crearHerramientasDeCodigo(crearCodigoStorage(this.depsDeCodigo(companyId)))) {
      tools.register(tool);
    }
  }

  /**
   * Crea (o devuelve) el agente del chat del IDE: un rol con todas las
   * herramientas de código y un prompt de mejora puntual. Idempotente por
   * nombre. Prefiere `claude-code` con Opus —la suscripción, y el que mejor
   * edita—; si no está, el proveedor preferido en su tier más alto.
   */
  async crearMejorador(companyId: string): Promise<Role> {
    await this.registrarHerramientasDeCodigo(companyId);
    const catalogo = this.store.listTools(companyId);
    const toolIds = catalogo.filter((tool) => HERRAMIENTAS_DE_CODIGO.has(tool.name)).map((tool) => tool.id);

    // Si ya existe, se lo pone al día: el Mejorador es "todas las herramientas
    // de código", y una herramienta nueva (instalar_dependencia) no le llegaba.
    const existente = this.store
      .listRoles(companyId)
      .find((role) => role.name === MEJORADOR_DE_CODIGO.nombre);
    if (existente) {
      const faltantes = toolIds.filter((id) => !existente.toolIds.includes(id));
      if (faltantes.length === 0) return existente;
      const actualizado = { ...existente, toolIds: [...existente.toolIds, ...faltantes] };
      this.store.saveRole(actualizado);
      this.actualizarRolEnCorridasVivas(companyId, actualizado);
      return actualizado;
    }

    const departamentos = this.store.listDepartments(companyId);
    let departamento =
      departamentos.find((dep) => dep.name.toLowerCase() === MEJORADOR_DE_CODIGO.departamento.toLowerCase()) ??
      departamentos[0];
    if (!departamento) {
      departamento = {
        id: ids.department(),
        companyId,
        name: MEJORADOR_DE_CODIGO.departamento,
        purpose: "Escribe y mejora el código.",
        parentId: null,
        position: { x: 120, y: 420 },
      };
      this.store.saveDepartment(departamento);
    }

    const conClaudeCode = this.providers.has("claude-code");
    const providerId = conClaudeCode ? "claude-code" : this.proveedorPreferido();
    if (!providerId) throw new Error("No hay ningún proveedor LLM configurado.");

    const rol: Role = {
      id: ids.role(),
      companyId,
      departmentId: departamento.id,
      name: MEJORADOR_DE_CODIGO.nombre,
      title: MEJORADOR_DE_CODIGO.titulo,
      systemPrompt: MEJORADOR_DE_CODIGO.systemPrompt,
      model: {
        providerId,
        modelSlug: conClaudeCode ? "claude-code/opus" : null,
        tier: "smart",
        escalado: null,
        temperature: null,
        maxOutputTokens: 8192,
      },
      toolIds,
      authority: "executor",
      reportsTo: null,
      maxTurns: 20,
      spendApprovalThresholdUsd: null,
      position: { x: 120 + departamentos.length * 40, y: 560 },
    };
    this.store.saveRole(rol);
    return rol;
  }

  /**
   * Aprobar una solicitud de dependencias **instala**: corre el gestor en la
   * sesión del repo (sandbox, sin scripts de instalación, con red) y commitea
   * `package.json` y el lockfile a nombre de quien aprobó. Si falla, la
   * aprobación falla con la salida del gestor y la solicitud sigue pendiente:
   * aprobar algo que no quedó instalado le mentiría al agente.
   *
   * Todo se revalida acá aunque la herramienta ya lo validó: lo que llega a la
   * base no se da por bueno.
   */
  private async instalarDependencias(companyId: string, request: AgentRequest): Promise<Record<string, unknown>> {
    const pedido = request.dependencia;
    if (!pedido) throw new Error("La solicitud no trae los paquetes.");
    for (const paquete of pedido.paquetes) {
      const v = validarPaquete(paquete);
      if (!v.ok) throw new Error(v.motivo);
    }
    const repo = this.store.getRepositorio(pedido.repoId);
    if (!repo || repo.companyId !== companyId) throw new Error("El repo de la solicitud ya no existe.");
    const escritor = this.titularDeEscritura(repo.id);
    if (escritor) {
      throw new Error(`${escritor} está escribiendo en el repo en su turno. Aprobá cuando termine: instalar cambia package.json.`);
    }
    const argv = argvDeInstalacion(pedido.gestor, pedido.paquetes, { dev: pedido.dev });
    const deps = this.depsDeCodigo(companyId);
    const espacio = await espacioDePersona(deps, repo);
    // La carpeta se vuelve a validar al aprobar: lo que llega a la base no se da por bueno.
    let carpeta = "";
    if (pedido.carpeta) {
      const ruta = await resolverEnWorktree(espacio.dir, pedido.carpeta);
      if (!ruta.ok || !existsSync(join(ruta.absoluta, "package.json"))) {
        throw new Error(`La carpeta "${pedido.carpeta}" no existe en el repo o no tiene package.json.`);
      }
      carpeta = ruta.relativa;
    }
    const resultado = await crearCodigoStorage(deps).ejecutar(espacio, argv, {
      corteMs: 5 * 60_000,
      repetir: true,
      ...(carpeta ? { carpeta } : {}),
    });
    const cola = (resultado.error ?? resultado.salida).slice(-1_500);
    if (resultado.error || resultado.cortadoPorTiempo || resultado.codigo !== 0) {
      throw new Error(`No se pudo instalar (${argvATexto(argv)}): ${cola}`);
    }
    const sesion = this.repos.sesionAbierta(repo.id, companyId);
    const persona = await this.repos.identidadDePersona();
    // Sin commits automáticos, package.json y el lockfile quedan como cambios
    // para que la persona los commitee con el resto.
    const sha = sesion && repo.commitsAutomaticos
      ? await this.repos.checkpoint(sesion, repo, { nombre: persona.nombre, id: "persona", email: persona.email }, request.reason, {
          titulo: `Instala ${pedido.paquetes.join(", ")}`,
        })
      : null;
    return { instalados: pedido.paquetes, comando: argvATexto(argv), checkpoint: sha, salida: cola.slice(-600) };
  }

  /**
   * Lo que ya se habló en una conversación del chat, para el pedido que sigue.
   *
   * Cada pedido es una corrida nueva y el agente arranca sin memoria; en un
   * chat eso se nota a la segunda frase ("ahora hacelo azul"). Viaja lo que se
   * pidió y lo que respondió el agente al cerrar su turno —no la traza entera:
   * se reenvía en cada vuelta del turno delegado—, con presupuesto y de lo más
   * nuevo a lo más viejo, que es lo que más importa si hay que cortar.
   */
  historiaDeConversacion(companyId: string, repoId: string, conversacionId: string, excepto: string): string {
    const previos = this.store
      .listRuns(companyId)
      .filter((r) => r.id !== excepto && r.foco?.repoId === repoId && r.foco.conversacionId === conversacionId)
      .sort((a, b) => b.startedAt - a.startedAt);
    if (previos.length === 0) return "";
    const PRESUPUESTO = 8_000;
    let restante = PRESUPUESTO;
    const bloques: string[] = [];
    for (const previo of previos.slice(0, 8)) {
      const respuesta = this.store
        .listEvents(previo.id)
        .filter((e): e is Extract<TraceEvent, { type: "agent.turn_end" }> => e.type === "agent.turn_end" && Boolean(e.summary))
        .at(-1)?.summary;
      const bloque = [
        `**Pedido:** ${previo.objective.slice(0, 1_500)}`,
        `**Respuesta:** ${(respuesta ?? (previo.stopReason ? `(sin respuesta: ${previo.stopReason})` : "(sin respuesta)")).slice(0, 2_500)}`,
      ].join("\n");
      if (bloque.length > restante) break;
      restante -= bloque.length;
      bloques.push(bloque);
    }
    return [
      "Esta conversación ya tuvo pedidos anteriores (el más reciente primero). Los cambios que se hicieron ya están en el código de la sesión:",
      ...bloques,
      "---",
      "Pedido nuevo:",
    ].join("\n\n");
  }

  /**
   * Un mensaje de commit escrito a partir del diff, como el ✨ de Cursor.
   *
   * Es una sola llamada al modelo más barato del proveedor preferido, no una
   * corrida: no hay nada que coordinar ni que auditar. Imita el estilo de los
   * últimos commits del repo —idioma, `tipo(área): …`, largo—, porque un
   * mensaje correcto pero escrito distinto al resto del historial es ruido
   * que alguien después reescribe a mano. El diff se acota: lo que importa
   * para describir un cambio está en los nombres de archivo y en las primeras
   * líneas de cada hunk.
   */
  async generarMensajeDeCommit(sesion: SesionCodigo, repo: Repositorio): Promise<string> {
    const { diff, archivos } = await this.scm.diffParaMensaje(sesion, repo);
    if (!diff.trim() && archivos.length === 0) throw new Error("No hay cambios para describir.");
    const providerId = this.proveedorPreferido();
    if (!providerId) throw new Error("No hay ningún proveedor LLM configurado.");
    const { provider, modelSlug } = await this.providers.resolveModel({
      providerId,
      modelSlug: null,
      tier: "cheap",
      escalado: null,
      temperature: null,
      maxOutputTokens: 400,
    });
    const historia = (await this.repos.log(sesion, repo).catch(() => []))
      .map((c) => c.mensaje)
      .concat(
        (
          await git(["log", "-15", "--format=%s", repo.ramaBase], { ...this.repos.contextoGit(sesion, repo), tolerar: true })
        ).stdout
          .split("\n")
          .filter(Boolean),
      )
      .filter((m) => !/^(Cambios hechos desde el IDE|Turno de |Cambios pendientes al integrar)/.test(m))
      .slice(0, 12);
    const TOPE = 14_000;
    const acotado = diff.length > TOPE ? `${diff.slice(0, TOPE)}\n[… diff recortado: ${diff.length - TOPE} caracteres más …]` : diff;
    const pedido = [
      "Write a git commit message for the change below. Reply with ONLY the message: no quotes, no code fences, no explanation.",
      "Match the style of this repository's recent commits (language, conventional-commit prefix like `feat(area):` if they use one, capitalization, length). If there are no examples, write it in Spanish (castellano rioplatense).",
      "First line: a summary of at most 72 characters saying WHAT changed and, if it fits, why. If the change is not trivial, add a blank line and up to 4 short bullet lines with the relevant details. Do not describe line-by-line edits; do not invent motivations that the diff does not show.",
      historia.length ? `Recent commits in this repo:\n${historia.map((m) => `- ${m}`).join("\n")}` : "",
      `Changed files: ${archivos.slice(0, 40).join(", ")}${archivos.length > 40 ? ` (+${archivos.length - 40})` : ""}`,
      `Diff:\n${acotado}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let texto = "";
    const corte = AbortSignal.timeout(120_000);
    for await (const evento of provider.chat({
      model: modelSlug,
      messages: [{ role: "user", content: pedido }],
      maxOutputTokens: 400,
      temperature: 0.2,
      signal: corte,
    })) {
      if (evento.type === "text_delta") texto += evento.text;
      else if (evento.type === "done" && evento.message.content) texto = evento.message.content;
    }
    const limpio = texto
      .trim()
      .replace(/^```[a-z]*\n?|```$/g, "")
      .replace(/^["'`]|["'`]$/g, "")
      // El CLI de Claude firma lo que escribe ("Co-Authored-By: Claude…",
      // "🤖 Generated with…"). Es un commit de la persona: esa firma no va.
      .split("\n")
      .filter((linea) => !/^\s*(co-authored-by:|signed-off-by:|🤖|generated with)/i.test(linea))
      .join("\n")
      .trim();
    if (!limpio) throw new Error("El modelo no devolvió un mensaje.");
    return limpio;
  }

  // --- Servicios (vista previa de un monorepo) ---------------------------------

  /**
   * Todo lo que hace falta para levantar un servicio: la sesión abierta (se
   * levanta sobre lo que cambiaron los agentes), la carpeta de la persona (de
   * ahí salen sus `.env` y su `node_modules`) y el mismo sandbox que los
   * comandos, con su opt-in.
   */
  private async entornoDeArranque(repo: Repositorio, servicioId: string): Promise<EntornoDeArranque> {
    const servicio = repo.servicios.find((s) => s.id === servicioId);
    if (!servicio) throw new Error(`El repo ${repo.nombre} no tiene un servicio "${servicioId}".`);
    const espacio = await espacioDePersona(this.depsDeCodigo(repo.companyId), repo);
    const tmp = this.directorios.sub(repo.companyId, "tmp", true);
    let aislamiento: EntornoDeArranque["aislamiento"] = null;
    if (!repo.comandos.sinAislamiento) {
      if (!hayAislamiento()) {
        throw new Error("En esta máquina no hay sandbox-exec: para levantar servicios sin aislamiento, habilitalo en la configuración del repo.");
      }
      aislamiento = {
        escribibles: [espacio.dir, tmp],
        noEscribibles: [join(this.repos.rutaClon(repo), ".git"), join(espacio.dir, ".git")],
      };
    }
    return {
      companyId: repo.companyId,
      repoId: repo.id,
      servicio,
      hermanos: repo.servicios,
      dir: espacio.dir,
      origen: repo.origen.tipo === "local" ? join(repo.origen.ruta, servicio.carpeta) : null,
      tmp,
      aislamiento,
    };
  }

  async prepararServicio(repo: Repositorio, servicioId: string): Promise<void> {
    await this.servicios.preparar(await this.entornoDeArranque(repo, servicioId));
  }

  async arrancarServicio(repo: Repositorio, servicioId: string): Promise<VistaDeServicio> {
    return this.servicios.arrancar(await this.entornoDeArranque(repo, servicioId));
  }

  /** ¿Ya tiene sus dependencias en la sesión? Sin sesión abierta, no se sabe: `null`. */
  serviciosPreparados(repo: Repositorio): Record<string, boolean | null> {
    const sesion = this.repos.sesionAbierta(repo.id, repo.companyId);
    const dir = sesion ? this.repos.rutaWorktree(sesion) : null;
    return Object.fromEntries(
      repo.servicios.map((s) => {
        if (!dir) return [s.id, null];
        const carpeta = join(dir, s.carpeta);
        return [s.id, !existsSync(join(carpeta, "package.json")) || existsSync(join(carpeta, "node_modules"))];
      }),
    );
  }

  /** Qué rol escribe ahora en un repo, o `null`. El IDE no guarda mientras tanto. */
  titularDeEscritura(repoId: string): string | null {
    return this.arriendos.titular(repoId);
  }

  /**
   * Corre un comando desde la terminal del IDE. Pasa por la misma allowlist y
   * el mismo sandbox que un agente: la API escucha en localhost, pero una
   * página cualquiera del navegador puede pegarle, y un endpoint que corre lo
   * que le pidan sería una puerta abierta a la máquina.
   */
  async ejecutarComoPersona(repo: Repositorio, argv: string[], corteMs: number, carpeta = "") {
    const deps = this.depsDeCodigo(repo.companyId);
    const espacio = await espacioDePersona(deps, repo);
    let relativa = "";
    if (carpeta) {
      const ruta = await resolverEnWorktree(espacio.dir, carpeta);
      if (!ruta.ok) throw new Error(ruta.motivo);
      relativa = ruta.relativa;
    }
    // Una persona que aprieta "npm test" quiere verlo correr: nada de reutilizar.
    return crearCodigoStorage(deps).ejecutar(espacio, argv, { corteMs, repetir: true, ...(relativa ? { carpeta: relativa } : {}) });
  }

  /**
   * Vuelve a registrar las herramientas de código después de cargar o borrar
   * un repo, y siembra sus filas: sin fila en `tools`, `role.toolIds` no puede
   * apuntarlas y nadie las puede recibir. El registro es el de la empresa, que
   * comparten las corridas vivas, así que lo ejecutable les llega solo.
   */
  async registrarHerramientasDeCodigo(companyId: string): Promise<void> {
    const { tools } = await this.companyRuntime(companyId);
    this.registrarCodigoEn(tools, companyId);
    await this.sembrarHerramientas(companyId);
  }

  /**
   * Deja registradas en la base las herramientas built-in de una empresa.
   *
   * Sin esto, un proyecto creado desde la UI nace **sin nada que asignarle a un
   * agente**: `ToolRegistry.forRole` sólo regala las de coordinación, y las de
   * `capability` y `skill` dependen de `role.toolIds`, que apunta a filas de la
   * tabla `tools`. El resultado era un agente explicando que no encuentra
   * `export_docx`. Es la misma siembra que hace `npm run db:seed`.
   *
   * Las de coordinación quedan afuera a propósito: se otorgan siempre, y
   * mostrarlas en el asignador las presentaría como si se pudieran quitar.
   */
  async sembrarHerramientas(companyId: string): Promise<number> {
    const { tools } = await this.companyRuntime(companyId);
    const existentes = new Set(this.store.listTools(companyId).map((tool) => tool.name));

    let nuevas = 0;
    for (const descripta of tools.describe()) {
      if (descripta.origin !== "capability" && descripta.origin !== "skill") continue;
      if (existentes.has(descripta.name)) continue;
      this.store.saveTool(companyId, { ...descripta, id: ids.tool() });
      nuevas += 1;
    }
    return nuevas;
  }

  /**
   * El proveedor con el que conviene armar agentes nuevos, entre los
   * configurados. Los Claude van primero porque sus tiers resuelven por el
   * mapa curado y el escalado por dificultad funciona sin fijar slugs;
   * OpenRouter cierra la lista porque resuelve por bandas de precio.
   */
  proveedorPreferido(): ProviderId | null {
    const prioridad: ProviderId[] = [
      "claude-sesion",
      "anthropic",
      "claude-code",
      "opencode",
      "openrouter",
    ];
    for (const id of prioridad) {
      if (this.providers.has(id)) return id;
    }
    return this.providers.list()[0]?.id ?? null;
  }

  /**
   * Genera el equipo de una plantilla dentro de una empresa.
   *
   * Siembra las herramientas si hace falta (sin filas en `tools`, `toolIds` no
   * puede apuntar a nada), crea departamentos y roles resolviendo la jerarquía
   * por nombre, y arma cada modelo con el proveedor disponible y escalado por
   * dificultad. Las herramientas que la plantilla nombra y el catálogo no
   * tiene **se nombran en la respuesta** — la regla de convocar: descartarlas
   * en silencio deja a un agente buscando una herramienta que le prometieron.
   * Los MCP sugeridos no se instalan solos: conectarlos lo decide una persona.
   */
  async generarEquipo(
    companyId: string,
    plantillaId: string,
  ): Promise<{
    roles: Role[];
    herramientasFaltantes: string[];
    mcpSugeridos: string[];
  }> {
    const plantilla = plantillaEquipo(plantillaId);
    if (!plantilla) throw new Error(`No existe la plantilla "${plantillaId}".`);

    await this.sembrarHerramientas(companyId);
    const catalogo = this.store.listTools(companyId);
    const porNombre = new Map(catalogo.map((tool) => [tool.name, tool.id]));

    // La plantilla puede preferir un proveedor: el equipo de software prefiere
    // `claude-code`, que es la suscripción y trae su propio harness de código.
    const providerId =
      (plantilla.proveedores ?? []).find((id) => this.providers.has(id)) ?? this.proveedorPreferido();
    if (!providerId) {
      throw new Error(
        "No hay ningún proveedor LLM configurado. Agregá una API key en .env y reiniciá.",
      );
    }

    // Departamentos primero, en fila, para que el organigrama arranque legible.
    const departamentos = new Map<string, Department>();
    const existentes = this.store.listDepartments(companyId);
    plantilla.departamentos.forEach((dep, indice) => {
      const previo = existentes.find(
        (candidato) => candidato.name.toLowerCase() === dep.nombre.toLowerCase(),
      );
      if (previo) {
        departamentos.set(dep.nombre, previo);
        return;
      }
      const nuevo: Department = {
        id: ids.department(),
        companyId,
        name: dep.nombre,
        purpose: dep.proposito,
        parentId: null,
        position: { x: 120 + indice * 260, y: 80 },
      };
      this.store.saveDepartment(nuevo);
      departamentos.set(dep.nombre, nuevo);
    });

    const faltantes = new Set<string>();
    const roles: Role[] = [];
    const porNombreDeRol = new Map<string, Role>();

    for (const rol of plantilla.roles) {
      const department = departamentos.get(rol.departamento);
      if (!department) throw new Error(`La plantilla referencia el área "${rol.departamento}" sin definirla.`);

      const toolIds: string[] = [];
      for (const nombre of rol.herramientas) {
        const id = porNombre.get(nombre);
        if (id) toolIds.push(id);
        else faltantes.add(nombre);
      }

      const nuevo: Role = {
        id: ids.role(),
        companyId,
        departmentId: department.id,
        name: rol.nombre,
        title: rol.titulo,
        systemPrompt: rol.systemPrompt,
        model: {
          providerId,
          modelSlug: null,
          tier: rol.escalado.tierMinimo,
          escalado: { activo: true, ...rol.escalado },
          temperature: null,
          maxOutputTokens: 4096,
        },
        toolIds,
        authority: rol.authority,
        reportsTo: null, // se resuelve después, cuando todos existen
        maxTurns: rol.maxTurns,
        spendApprovalThresholdUsd: null,
        // (0,0) alcanza: OrgGraph.autoLayout acomoda por jerarquía las
        // posiciones repetidas y respeta las movidas a mano.
        position: { x: 0, y: 0 },
      };
      roles.push(nuevo);
      porNombreDeRol.set(rol.nombre, nuevo);
    }

    for (const [indice, rol] of plantilla.roles.entries()) {
      const jefe = rol.reportaA ? porNombreDeRol.get(rol.reportaA) : null;
      const nuevo = roles[indice]!;
      nuevo.reportsTo = jefe?.id ?? null;
      this.store.saveRole(nuevo);
    }

    return {
      roles,
      herramientasFaltantes: [...faltantes],
      mcpSugeridos: plantilla.mcpSugeridos,
    };
  }

  /**
   * ¿Está avanzando ahora mismo? Es lo único que impide borrarla.
   *
   * El estado se lee del orquestador y no de `active.run`, que queda viejo: al
   * detener una corrida se persiste el snapshot pero esa referencia no se
   * actualiza, y una corrida ya detenida seguía respondiendo "está en curso".
   */
  estaViva(runId: string): boolean {
    const activa = this.runs.get(runId);
    return activa != null && activa.orchestrator.snapshot.status === "running";
  }

  /**
   * Si la corrida sigue **en memoria**, que es lo único que se puede retomar.
   *
   * No es `estaViva`: una corrida pausada o detenida no está corriendo y sin
   * embargo se puede continuar. Existe para que quien llama a `resume` valide
   * antes de contestar — el error viajaba por una promesa sin dueño, y una
   * rechazada sin manejar **mata el proceso de Node**, llevándose puestas las
   * corridas que sí estaban trabajando.
   */
  estaEnMemoria(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Si todavía se puede continuar: sigue en memoria y no llegó a un estado
   * terminal.
   *
   * `estaViva` es más angosta —sólo `running`— y por eso no sirve para decidir
   * un borrado: una corrida `paused` o `awaiting_approval` no avanza pero
   * conserva su estado vivo, y borrarla tira trabajo que alcanzaba con
   * continuar. La limpieza en lote se llevaba puestas justamente esas.
   */
  sePuedeContinuar(runId: string): boolean {
    const activa = this.runs.get(runId);
    return activa != null && !esCorridaTerminal(activa.orchestrator.snapshot.status);
  }

  /**
   * Si la empresa ya tiene una corrida en curso.
   *
   * Lo consulta el planificador de misiones antes de largar otra: dos equipos
   * completos escribiendo sobre los mismos entregables se pisan, y el resultado
   * es una versión que mezcla dos trabajos distintos. Cuenta también la que
   * espera una aprobación, porque esa corrida sigue viva aunque no avance.
   */
  tieneCorridaViva(companyId: string): boolean {
    for (const activa of this.runs.values()) {
      const corrida = activa.orchestrator.snapshot;
      if (corrida.companyId !== companyId) continue;
      if (corrida.status === "running" || corrida.status === "awaiting_approval") return true;
    }
    return false;
  }

  /**
   * Suelta una corrida de la memoria del servidor.
   *
   * Al borrarla de la base hay que sacarla también de acá: si no, queda un
   * orquestador vivo que se puede seguir avanzando y que escribe eventos de una
   * corrida que ya no existe.
   */
  olvidarCorrida(runId: string): void {
    const activa = this.runs.get(runId);
    if (!activa) return;
    activa.orchestrator.stop();
    this.runs.delete(runId);
    this.runSubscribers.delete(runId);
  }

  /**
   * Suelta una empresa entera de la memoria del servidor.
   *
   * Es `olvidarCorrida` un nivel más arriba, y hace falta por lo mismo: el
   * runtime de empresa sostiene **procesos de servidores MCP**, que no se caen
   * porque borres filas en SQLite. Sin esto, borrar una empresa dejaba sus
   * conexiones vivas hasta reiniciar el servidor, y el Hub seguía mostrando en
   * verde los servidores de algo que ya no existe.
   */
  async olvidarEmpresa(companyId: string): Promise<void> {
    for (const [runId, activa] of [...this.runs]) {
      if (activa.companyId === companyId) this.olvidarCorrida(runId);
    }
    const runtime = this.companies.get(companyId);
    if (!runtime) return;
    this.companies.delete(companyId);
    await runtime.mcp.disconnectAll();
  }

  /**
   * Borra una empresa de los tres lados donde vive: memoria, base y disco.
   *
   * Están juntos a propósito. Borrar sólo la base es lo que había antes, y
   * dejaba la carpeta con los Word, los PDF y los videos sin nadie a quien
   * pertenecer — invisible desde la UI, porque la UI navega por empresa y la
   * empresa ya no está.
   */
  /**
   * Renombra un proyecto y lleva sus carpetas detrás.
   *
   * Cambiar la fila sola no alcanza: la carpeta de `data/proyectos/` seguiría
   * con el nombre viejo (se encuentra por la marca, pero una persona lee
   * nombres) y el vault, que se resuelve por nombre, abriría uno vacío al lado
   * del que tiene todo lo aprendido. Mudar la carpeta, a su vez, rompe lo que
   * guardaba rutas absolutas: los worktrees de git y los servidores MCP que
   * escriben adentro (el Playwright con `--output-dir`). Por eso no se renombra
   * con una corrida en curso: sus agentes tienen abiertos archivos y comandos
   * en la ruta vieja.
   */
  async renombrarEmpresa(
    companyId: string,
    nombre: string,
  ): Promise<{ ok: true; company: Company; carpeta: string | null } | { ok: false; motivo: string }> {
    const actual = this.store.getCompany(companyId);
    if (!actual) return { ok: false, motivo: "La empresa no existe." };
    const limpio = nombre.trim();
    const parsed = companySchema.safeParse({ ...actual, name: limpio, updatedAt: Date.now() });
    if (!limpio || !parsed.success) return { ok: false, motivo: "El nombre no es válido." };
    if (limpio === actual.name) return { ok: true, company: actual, carpeta: null };
    if (this.tieneCorridaViva(companyId)) {
      return {
        ok: false,
        motivo: "El proyecto tiene una corrida en curso: sus agentes trabajan sobre la carpeta actual. Detenela antes de renombrarlo.",
      };
    }

    // Los servicios corren adentro de la carpeta que se va a mudar.
    if (this.servicios.hayVivos({ companyId })) {
      return {
        ok: false,
        motivo: "El proyecto tiene servicios levantados (vista previa): corren adentro de su carpeta. Detenelos antes de renombrarlo.",
      };
    }
    this.store.saveCompany(parsed.data);
    await this.contexto.renombrar(companyId, actual.name, limpio);

    const mudanza = this.directorios.mudar(companyId);
    if (mudanza) {
      await this.repos.repararWorktrees(companyId);
      const cambio = {
        viejaAbs: mudanza.vieja,
        nuevaAbs: mudanza.nueva,
        viejaRel: relative(repoRoot, mudanza.vieja),
        nuevaRel: relative(repoRoot, mudanza.nueva),
      };
      let reescritos = 0;
      for (const server of this.store.listMcpServers(companyId)) {
        const reescrito = reescribirRutasMcp(server, cambio);
        if (reescrito) {
          this.store.saveMcpServer(mcpServerSchema.parse(reescrito));
          reescritos += 1;
        }
      }
      // El sync reconecta los que cambiaron: un proceso MCP arrancado con la
      // ruta vieja la recrearía al primer archivo que escriba.
      if (reescritos > 0 && this.companies.has(companyId)) await this.companyRuntime(companyId);
    }
    return { ok: true, company: parsed.data, carpeta: mudanza?.nueva ?? null };
  }

  async eliminarEmpresa(
    companyId: string,
  ): Promise<{ ok: true; archivos: number; bytes: number } | { ok: false; motivo: string }> {
    if (this.tieneCorridaViva(companyId)) {
      return {
        ok: false,
        motivo: "La empresa tiene una corrida en curso. Detenela antes de borrarla.",
      };
    }

    this.servicios.detenerDeEmpresa(companyId);
    await this.olvidarEmpresa(companyId);
    this.store.deleteCompany(companyId);

    // Se lleva la carpeta entera del proyecto: salida, clones y worktrees. Las
    // ramas `orq/*` que ya se integraron al repo de la persona quedan: ese
    // repo es suyo, y el diálogo de borrado lo dice.
    const disco = await this.exports.removeCompany(companyId);
    this.directorios.olvidar(companyId);
    // Que no hubiera carpeta no es un error: una empresa que nunca produjo un
    // archivo se borra igual.
    return disco.ok ? disco : { ok: true, archivos: 0, bytes: 0 };
  }

  /**
   * La salud de los servidores que **siguen configurados**.
   *
   * `McpBridge.disconnect` cierra la conexión y da de baja las herramientas,
   * pero no publica un último estado, así que el mapa de salud se quedaba con la
   * entrada del servidor borrado. En el Hub eso se veía como un servidor
   * fantasma: en `ready`, con su botón de reconectar, y sin forma de sacarlo
   * porque ya no tenía configuración detrás. La lista autoritativa es la de la
   * base, no la memoria del runtime.
   */
  mcpHealth(companyId: string): McpServerHealth[] {
    const runtime = this.companies.get(companyId);
    if (!runtime) return [];
    const vigentes = new Set(this.store.listMcpServers(companyId).map((server) => server.id));
    for (const serverId of runtime.health.keys()) {
      if (!vigentes.has(serverId)) runtime.health.delete(serverId);
    }
    return [...runtime.health.values()];
  }

  /**
   * Borra un servidor MCP en cascada: desconecta el proceso (no se cae solo
   * por borrar filas — misma lección que `eliminarEmpresa`), borra sus filas
   * de `tools` y poda los `toolIds` muertos de los roles. Antes el CRUD sólo
   * borraba la fila del servidor y quedaban herramientas fantasma en la base y
   * roles apuntando a ids inexistentes.
   */
  async eliminarServidorMcp(
    companyId: string,
    serverId: string,
  ): Promise<{ herramientas: number; rolesPodados: number }> {
    const runtime = this.companies.get(companyId);
    await runtime?.mcp.disconnect(serverId);
    runtime?.health.delete(serverId);

    const herramientas = this.store
      .listTools(companyId)
      .filter((tool) => tool.mcpServerId === serverId).length;
    this.store.deleteToolsByMcpServer(companyId, serverId);
    this.store.deleteMcpServer(serverId);
    olvidarOAuth(this.dirOAuth, serverId);
    const rolesPodados = this.store.podarToolIdsHuerfanos(companyId);
    return { herramientas, rolesPodados };
  }

  async reconnectMcp(companyId: string, serverId: string): Promise<boolean> {
    const runtime = await this.companyRuntime(companyId);
    const server = this.store.listMcpServers(companyId).find((s) => s.id === serverId);
    if (!server) return false;
    await runtime.mcp.connect(server);
    return true;
  }

  /** Ejecuta una tool a mano desde el Hub, para probar un servidor MCP. */
  async probeTool(
    companyId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const runtime = await this.companyRuntime(companyId);
    const tool = runtime.tools.get(toolName);
    if (!tool) return { ok: false, content: `La herramienta "${toolName}" no está registrada.` };

    // Se arma un contexto mínimo: la prueba manual no pertenece a ninguna
    // corrida, así que las herramientas de coordinación no son invocables acá.
    if (tool.origin === "coordination" || tool.origin === "skill" || tool.origin === "creada") {
      return {
        ok: false,
        content:
          tool.origin === "coordination"
            ? "Las herramientas de coordinación necesitan una corrida en curso: " +
              "actúan sobre bandejas y tareas que todavía no existen."
            : tool.origin === "creada"
              ? "Las herramientas compuestas encadenan pasos de coordinación y " +
                "habilidades, que sólo existen dentro de una corrida."
              : "Las habilidades exportan un entregable, y los entregables pertenecen " +
                "a una corrida. Arrancá una y pedile al agente que la use.",
      };
    }

    const roles = this.store.listRoles(companyId);
    const actor = roles[0];
    if (!actor) return { ok: false, content: "La empresa no tiene roles definidos." };

    const result = await tool.execute(args, {
      runId: "probe",
      tick: 0,
      actor,
      workspace: null as never, // no se usa: las de coordinación se rechazan arriba
      currentThreadId: null,
      currentMessageId: null,
      replyToRoleId: null,
    });
    return { ok: result.ok, content: result.content };
  }

  listTools(companyId: string): ReturnType<ToolRegistry["describe"]> {
    const runtime = this.companies.get(companyId);
    return runtime ? runtime.tools.describe() : new ToolRegistry().describe();
  }

  /**
   * Refleja en la base las herramientas descubiertas, para que el diseñador de
   * la empresa pueda asignarlas a un rol y la asignación sobreviva a un
   * reinicio aunque el servidor MCP esté caído en ese momento.
   */
  /** Dónde viven los tokens OAuth de los servidores MCP: fuera de la base. Ver `mcp-oauth.ts`. */
  private get dirOAuth(): string {
    return join(dirname(this.env.databaseUrl), "mcp-oauth");
  }

  private readonly fabricaOAuth = (server: McpServer, alPedir: (url: URL) => void) =>
    crearFabricaOAuth(this.dirOAuth, `${this.env.apiUrl.replace(/\/$/, "")}/api/mcp/oauth/callback`)(server, alPedir);

  /** La vuelta del navegador: busca en todas las empresas el servidor que esperaba ese `state`. */
  async completarAutorizacionMcp(estado: string, codigo: string): Promise<{ serverId: string; nombre: string } | null> {
    for (const runtime of this.companies.values()) {
      const hecho = await runtime.mcp.completarAutorizacion(estado, codigo);
      if (hecho) return hecho;
    }
    return null;
  }

  /**
   * Las tools de un servidor que recién se conectó van a los roles que se
   * anotaron al darlo de alta (`otorgarAlConectar`), también en las corridas
   * vivas, y la lista se vacía: es de una sola vez.
   */
  private otorgarAlConectar(companyId: string, serverId: string): void {
    const server = this.store.listMcpServers(companyId).find((s) => s.id === serverId);
    if (!server?.otorgarAlConectar.length) return;
    const ids = this.store
      .listTools(companyId)
      .filter((tool) => tool.mcpServerId === serverId)
      .map((tool) => tool.id);
    if (!ids.length) return;
    for (const rol of this.store.listRoles(companyId)) {
      if (!server.otorgarAlConectar.includes(rol.id)) continue;
      const actualizado = { ...rol, toolIds: [...new Set([...rol.toolIds, ...ids])] };
      this.store.saveRole(actualizado);
      this.actualizarRolEnCorridasVivas(companyId, actualizado);
    }
    this.store.saveMcpServer({ ...server, otorgarAlConectar: [] });
  }

  private persistMcpTools(companyId: string, tools: ToolRegistry): void {
    const existing = new Map(this.store.listTools(companyId).map((tool) => [tool.name, tool]));
    for (const described of tools.describe()) {
      // Las compuestas ya están persistidas **con su composición**; `describe`
      // no la lleva, así que re-guardarlas desde acá las dejaría vacías: una
      // herramienta que existe pero no ejecuta nada.
      if (described.origin === "creada") continue;
      const previous = existing.get(described.name);
      this.store.saveTool(companyId, { ...described, id: previous?.id ?? ids.tool() });
    }
  }

  // --- Corridas ------------------------------------------------------------

  async startRun(input: CreateRunInput): Promise<Run> {
    const company = this.store.getCompany(input.companyId);
    if (!company) throw new Error(`No existe la empresa "${input.companyId}".`);

    const runtime = await this.companyRuntime(company.id);
    const config: CompanyConfig = {
      company,
      departments: this.store.listDepartments(company.id),
      roles: this.store.listRoles(company.id),
      policies: this.store.listPolicies(company.id),
      tools: this.store.listTools(company.id),
      mcpServers: this.store.listMcpServers(company.id),
      learnings: this.store.listLearnings(company.id),
      requests: this.store.listRequests(company.id),
      // Lo que la empresa ya produjo, para que cualquier área lo lea y lo
      // versione en lugar de reescribirlo con otra clave.
      artifacts: this.store.listArtifactsByCompany(company.id),
      // El trabajo que quedó abierto se adopta en esta corrida: un encargo
      // largo se retoma donde quedó, y sus dueños arrancan con trabajo
      // pendiente, así que el scheduler los convoca desde el primer ciclo.
      tasks: this.store.listTasksAbiertasByCompany(company.id),
    };
    if (config.roles.length === 0) {
      throw new Error("La empresa no tiene roles: definí al menos uno antes de arrancar.");
    }

    // Corrida enfocada (el chat del IDE): un solo agente, sobre un repo, sin
    // el trabajo abierto de los demás. El organigrama se reduce a ese rol
    // —si quedaran los otros, el pedido se volvería un encargo de equipo y el
    // "mejorá esta función" terminaba en una reunión de cuatro agentes—.
    const foco = input.foco ?? null;
    if (foco) {
      const rol = config.roles.find((role) => role.id === foco.rolId);
      if (!rol) throw new Error("El agente elegido ya no existe en la empresa.");
      const repo = this.store.getRepositorio(foco.repoId);
      if (!repo || repo.companyId !== company.id) throw new Error("El repo elegido no es de esta empresa.");
      config.roles = [rol];
      config.tasks = [];
    }

    const run: Run = {
      id: ids.run(),
      companyId: company.id,
      objective: input.objective,
      status: "idle",
      mode: input.mode,
      tick: 0,
      // Un pedido puntual no necesita cincuenta ciclos: si en cuatro no cerró,
      // el pedido era otra cosa y conviene que lo vea una persona.
      maxTicks: input.maxTicks ?? (input.foco ? 4 : this.env.defaultMaxTicks),
      budgetUsd: input.budgetUsd ?? company.budgetUsd ?? this.env.defaultBudgetUsd,
      spentUsd: 0,
      cronIntervalMs: input.cronIntervalMs ?? 60_000,
      stopReason: null,
      startedAt: Date.now(),
      endedAt: null,
      foco: foco
        ? { rolId: foco.rolId, repoId: foco.repoId, ...(foco.conversacionId ? { conversacionId: foco.conversacionId } : {}) }
        : null,
    };

    const bus = new EventBus();
    bus.subscribe((event) => {
      this.store.saveEvent(event);
      this.broadcastRun(run.id, event);
    });

    const state = new RunState(run.id, config, {
      saveMessage: (message) => this.store.saveMessage(message),
      saveTask: (task) => this.store.saveTask(task),
      saveArtifact: (artifact) => this.store.saveArtifact(artifact, company.id),
      saveApproval: (approval) => this.store.saveApproval(approval),
      // La lección va a la base —de ahí sale la memoria corta del prompt— y
      // además refresca su nota en el vault, para que lo que la empresa aprende
      // trabajando se pueda leer y corregir en Obsidian sin correr un script.
      saveLearning: (learning) => {
        this.store.saveLearning(learning);
        void this.espejarAprendizajes(company, learning.topic);
      },
      saveRequest: (request) => this.store.saveRequest(request),
      // Un especialista convocado en medio de una corrida es un rol de la
      // empresa como cualquier otro: queda disponible para las siguientes.
      saveRole: (role, department) => {
        if (department) this.store.saveDepartment(department);
        this.store.saveRole(role);
      },
      // Una herramienta compuesta creada en medio de la corrida es de la
      // empresa, como el especialista convocado: queda para las siguientes.
      saveTool: (tool) => this.store.saveTool(company.id, tool),
    });

    const ledger = new RunLedger(run.budgetUsd, (record) => {
      this.store.saveLedgerEntry({
        id: ids.ledger(),
        runId: run.id,
        roleId: record.roleId,
        providerId: record.providerId,
        modelSlug: record.modelSlug,
        tick: record.tick,
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        cachedInputTokens: record.usage.cachedInputTokens ?? 0,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        createdAt: record.at,
      });
    });

    const orchestrator = new Orchestrator(run, state, {
      bus,
      providers: this.providers,
      tools: runtime.tools,
      ledger,
      concurrency: this.env.agentConcurrency,
      // Lo que la empresa produjo, para que un agente pueda **verlo**. Se presta
      // en sólo lectura; producir sigue yendo por las herramientas del org.
      dirDeTrabajo: this.exports.dirDeEmpresa(company.id),
      // El código del proyecto: cada turno de un rol que programa abre su
      // espacio (worktree, arriendo, resumen) y lo cierra con un checkpoint.
      codigo: {
        abrirTurno: (role, runId) =>
          abrirTurnoDeCodigo(this.depsDeCodigo(company.id), role, runId, {
            ...(foco ? { repoPrincipalId: foco.repoId } : {}),
          }),
      },
      // El mapa del árbol de contexto, resuelto por turno: un agente escribe
      // una nota en un ciclo y el resto la ve en el siguiente.
      mapaDeContexto: async () =>
        mapaDeContextoEnPrompt(
          await this.contexto.mapa({ id: company.id, nombre: company.name }),
        ),
      fechaHoy: () =>
        new Date().toLocaleDateString("es-AR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
      onRunUpdate: (updated) => this.store.saveRun(updated),
    });

    this.runs.set(run.id, { run, state, bus, ledger, orchestrator, companyId: company.id });
    this.store.saveRun(run);

    // El encargo entra como un mensaje de la persona a cargo al rol de mayor
    // autoridad: la empresa arranca porque alguien pidió algo, no por magia.
    const entryPoint = foco
      ? config.roles[0]!
      : (config.roles.find((role) => role.authority === "executive" && !role.reportsTo) ??
        config.roles.find((role) => !role.reportsTo) ??
        config.roles[0]!);
    await state.forActor(null).sendMessage({
      toRoleId: entryPoint.id,
      toDepartmentId: null,
      type: "human",
      subject: foco ? "Pedido desde el IDE" : "Encargo",
      body: [
        foco?.conversacionId ? this.historiaDeConversacion(company.id, foco.repoId, foco.conversacionId, run.id) : "",
        input.objective,
        foco?.contexto ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      threadId: null,
      inReplyTo: null,
    });

    if (input.mode === "continuous") {
      void orchestrator.runContinuous();
    } else if (input.mode === "cron") {
      orchestrator.startCron(run.cronIntervalMs);
    }

    return orchestrator.snapshot;
  }

  active(runId: string): ActiveRun | undefined {
    return this.runs.get(runId);
  }

  snapshot(runId: string): Run | null {
    const active = this.runs.get(runId);
    return active ? active.orchestrator.snapshot : this.store.getRun(runId);
  }

  async tick(runId: string): Promise<{ advanced: boolean; reason: string }> {
    const active = this.require(runId);
    const result = await active.orchestrator.tick();
    this.store.saveRun(active.orchestrator.snapshot);
    return result;
  }

  async resume(runId: string): Promise<void> {
    const active = this.require(runId);
    await active.orchestrator.runContinuous();
    this.store.saveRun(active.orchestrator.snapshot);
  }

  /**
   * Retoma sola una corrida que se había quedado esperando una respuesta.
   *
   * Contestar una pregunta tiene que hacer que el trabajo continúe: si la
   * respuesta entra a la bandeja pero nadie vuelve a mover el ciclo, el agente
   * la lee recién si alguien aprieta "continuar" a mano, y eso convierte una
   * espera asincrónica en una intervención manual.
   *
   * No bloquea la respuesta HTTP: la corrida puede durar minutos.
   */
  reanudarSiEsperaba(runId: string | null): void {
    if (!runId) return;
    const active = this.runs.get(runId);
    if (!active) return;
    const estado = active.orchestrator.snapshot.status;
    // También vale desde `paused`: resolver la última pendiente deja la corrida
    // en pausa (`Orchestrator.resolveApproval`), y sin esto contestar una
    // aprobación no reanudaba nada —había que apretar "continuar" a mano,
    // justo lo que esta función existe para evitar—.
    if (estado !== "awaiting_approval" && estado !== "paused") return;
    // Si todavía queda otra pregunta o aprobación sin responder, se sigue
    // esperando: reanudar volvería a frenar en el mismo lugar.
    if (active.state.requests.some((pedido) => pedido.status === "pending")) return;
    if (active.state.pendingApprovals().length > 0) return;

    void this.resume(runId).catch(() => {
      // Un fallo acá ya quedó registrado en la traza de la corrida; no puede
      // tumbar la respuesta a quien contestó la solicitud.
    });
  }

  pause(runId: string): void {
    const active = this.require(runId);
    active.orchestrator.pause();
    // Se persiste como en `stop`: sin esto la fila queda en `running` y una
    // caída del servidor la deja informando que avanzaba cuando estaba en
    // pausa.
    this.store.saveRun(active.orchestrator.snapshot);
  }

  stop(runId: string): void {
    const active = this.require(runId);
    active.orchestrator.stop();
    this.store.saveRun(active.orchestrator.snapshot);
  }

  /** Mensaje inyectado por la persona a cualquier agente, en cualquier momento. */
  async inject(runId: string, toRoleId: string, subject: string, body: string): Promise<void> {
    const active = this.require(runId);
    // Sin esto el mensaje entra a una bandeja que nadie va a leer y el endpoint
    // responde OK: el usuario cree que escribió y no pasa nada.
    const estado = active.orchestrator.snapshot.status;
    if (["completed", "stopped", "failed", "budget_exceeded"].includes(estado)) {
      throw new Error(
        `La corrida ya terminó (${estado}), así que nadie va a leer el mensaje. ` +
          `Arrancá una corrida nueva para seguir trabajando.`,
      );
    }
    if (!active.state.getRole(toRoleId)) throw new Error(`No existe el rol "${toRoleId}".`);
    const message = await active.state.forActor(null).sendMessage({
      toRoleId,
      toDepartmentId: null,
      type: "human",
      subject: subject || "Mensaje de la persona a cargo",
      body,
      threadId: null,
      inReplyTo: null,
    });
    active.bus.emit({
      type: "agent.message",
      runId,
      tick: active.state.tick,
      messageId: message.id,
      fromRoleId: null,
      toRoleId,
      toDepartmentId: null,
      messageType: "human",
      subject: message.subject,
      preview: body.slice(0, 300),
    });
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "grant" | "deny",
    resolution: string,
  ): Promise<boolean> {
    const active = this.require(runId);
    return active.orchestrator.resolveApproval(
      approvalId,
      decision === "grant" ? "granted" : "denied",
      resolution,
    );
  }

  /**
   * Reescribe en el vault la nota de un tema de la memoria.
   *
   * Se hace por tema y no por lección porque así se lee: una nota "Rodaje" con
   * todo lo aprendido sobre rodaje, no cincuenta archivos de un párrafo. Falla
   * en silencio a propósito —un disco lleno no puede tumbar una corrida— pero
   * deja el error en el log del servidor.
   *
   * Es público porque la memoria entra por dos puertas: `record_lesson` de un
   * agente y la API cuando la carga una persona. Si sólo espejara la primera,
   * lo que vos escribís no aparecería en Obsidian y el vault mentiría por
   * omisión.
   */
  async espejarAprendizajes(
    company: { id: string; name: string },
    topic: string,
  ): Promise<void> {
    try {
      const todas = this.store.listLearnings(company.id);
      const delTema = todas.filter((learning) => learning.topic === topic);
      // Un tema que se quedó sin lecciones tiene que **desaparecer** del vault.
      // Salir sin hacer nada dejaba la nota entera en Obsidian después de
      // borrar su última lección: el vault seguía enseñando algo que la empresa
      // ya no cree, y eso es peor que no espejar, porque nadie sospecha de una
      // nota que está ahí.
      if (delTema.length === 0) {
        await this.contexto.borrar({ id: company.id, nombre: company.name }, rutaDeTema(topic));
        return;
      }
      await this.contexto.escribir(
        { id: company.id, nombre: company.name },
        rutaDeTema(topic),
        notaDeAprendizajes({
          tema: topic,
          empresa: company.name,
          // La fecha entra formateada, como en el render de documentos: acá
          // adentro no hay reloj.
          fecha: new Date().toISOString().slice(0, 10),
          lecciones: delTema,
          temas: [...new Set(todas.map((l) => l.topic))],
        }),
      );
    } catch (error) {
      console.error("no se pudo espejar la memoria al vault:", error);
    }
  }

  private require(runId: string): ActiveRun {
    const active = this.runs.get(runId);
    if (!active) {
      throw new Error(
        `La corrida "${runId}" no está activa en memoria. Las corridas no sobreviven a un ` +
          `reinicio del servidor: podés leer su traza, pero no continuarla.`,
      );
    }
    return active;
  }

  // --- Solicitudes de los agentes ------------------------------------------

  /**
   * Aplica una solicitud aprobada sobre la configuración de la empresa.
   *
   * Los cambios son a nivel empresa y persisten, pero **una corrida en curso no
   * los ve**: su configuración se congela al arrancar. Es deliberado —
   * reorganizar una empresa a mitad de un trabajo confundiría a los agentes que
   * ya están coordinando— y por eso el mensaje de vuelta lo aclara.
   */
  async applyRequest(
    companyId: string,
    request: AgentRequest,
    override: RoleProposal | null,
    comando: { prefijo?: string[]; alcance: "siempre" | "una-vez" } | null = null,
  ): Promise<Record<string, unknown>> {
    if (request.type === "dependencia") {
      return this.instalarDependencias(companyId, request);
    }

    if (request.type === "comando") {
      if (!request.comando) throw new Error("La solicitud no trae el comando.");
      const repo = this.store.getRepositorio(request.comando.repoId);
      if (!repo || repo.companyId !== companyId) throw new Error("El repo de la solicitud ya no existe.");
      const alcance = comando?.alcance ?? "una-vez";
      if (alcance === "una-vez") {
        this.repos.actualizarComandos(repo, { unaVez: [...repo.comandos.unaVez, request.comando.argv] });
        return { comando: argvATexto(request.comando.argv), alcance };
      }
      // "Siempre" permite un prefijo, que la persona puede recortar: pidieron
      // `npm run e2e -- --grep login` y lo que tiene sentido permitir es
      // `npm run e2e`. El prefijo pasa por la misma validación que la UI.
      const prefijo = comando?.prefijo?.length ? comando.prefijo : request.comando.argv;
      const pedido = request.comando.argv;
      if (!prefijo.every((token, i) => pedido[i] === token)) {
        throw new Error("El prefijo tiene que ser el principio del comando pedido.");
      }
      const validacion = validarPrefijoPermitido(prefijo);
      if (!validacion.ok) throw new Error(validacion.motivo);
      const ya = repo.comandos.permitidos.some((p) => p.join("\u0000") === prefijo.join("\u0000"));
      if (!ya) this.repos.actualizarComandos(repo, { permitidos: [...repo.comandos.permitidos, prefijo] });
      return { comando: argvATexto(prefijo), alcance };
    }

    if (request.type === "create_role") {
      const propuesta = override ?? request.roleProposal;
      if (!propuesta) throw new Error("La solicitud no trae una propuesta de rol.");

      const roles = this.store.listRoles(companyId);
      if (roles.some((role) => role.name.toLowerCase() === propuesta.name.toLowerCase())) {
        throw new Error(`Ya existe un rol llamado "${propuesta.name}".`);
      }

      // El departamento se crea si no existe: el agente propone por nombre, no
      // conoce los IDs.
      const departments = this.store.listDepartments(companyId);
      let department = departments.find(
        (dep) => dep.name.toLowerCase() === propuesta.departmentName.toLowerCase(),
      );
      if (!department) {
        department = {
          id: ids.department(),
          companyId,
          name: propuesta.departmentName,
          purpose: "",
          parentId: null,
          position: { x: 120 + departments.length * 260, y: 420 },
        };
        this.store.saveDepartment(department);
      }

      const jefe =
        roles.find(
          (role) => role.name.toLowerCase() === (propuesta.reportsToName ?? "").toLowerCase(),
        ) ??
        (request.requestedByRoleId
          ? roles.find((role) => role.id === request.requestedByRoleId)
          : undefined);

      const company = this.store.getCompany(companyId);
      const nuevo: Role = {
        id: ids.role(),
        companyId,
        departmentId: department.id,
        name: propuesta.name,
        title: propuesta.title,
        systemPrompt: propuesta.systemPrompt,
        // Hereda el modelo por defecto de la empresa con escalado por
        // dificultad acotado según la autoridad propuesta: quien lo aprueba
        // puede cambiarlo después desde el diseñador. El slug fijo de la
        // empresa —si lo hay— se respeta: puede ser la única forma de resolver
        // en proveedores sin precios ni mapa curado.
        model: conEscaladoPorAutoridad(
          company?.defaultModel ?? {
            providerId: "openrouter",
            modelSlug: null,
            tier: "cheap",
            escalado: null,
            temperature: null,
            maxOutputTokens: 2048,
          },
          propuesta.authority,
        ),
        toolIds: [],
        authority: propuesta.authority,
        reportsTo: jefe?.id ?? null,
        maxTurns: 6,
        spendApprovalThresholdUsd: null,
        position: { x: department.position.x, y: department.position.y + 90 },
      };
      this.store.saveRole(nuevo);

      // Se suma a la corrida viva, si la hay: así empieza a trabajar en el
      // ciclo siguiente y el resto lo ve en su lista de colegas.
      const activa = request.runId ? this.runs.get(request.runId) : undefined;
      activa?.state.addRole(nuevo, department);

      return { roleId: nuevo.id, roleName: nuevo.name, departmentId: department.id };
    }

    if (request.type === "tool_access") {
      if (!request.requestedByRoleId) throw new Error("La solicitud no indica quién la pidió.");
      const rol = this.store.listRoles(companyId).find((r) => r.id === request.requestedByRoleId);
      if (!rol) throw new Error("El rol que pidió el acceso ya no existe.");

      const catalogo = this.store.listTools(companyId);
      const encontradas = request.toolNames
        .map((name) => catalogo.find((tool) => tool.name === name))
        .filter((tool): tool is Tool => tool != null);
      const faltantes = request.toolNames.filter(
        (name) => !catalogo.some((tool) => tool.name === name),
      );

      const toolIds = [...new Set([...rol.toolIds, ...encontradas.map((tool) => tool.id)])];
      this.store.saveRole({ ...rol, toolIds });
      const enCurso = request.runId ? this.runs.get(request.runId) : undefined;
      enCurso?.state.updateRoleTools(rol.id, toolIds);
      return { otorgadas: encontradas.map((tool) => tool.name), inexistentes: faltantes };
    }

    if (request.type === "mcp_server") {
      if (request.mcpProposal.length === 0) {
        throw new Error("La solicitud no trae ningún servidor propuesto.");
      }

      const resultado = await this.instalarServidoresMcp(companyId, request.mcpProposal, {
        otorgarARolId: request.requestedByRoleId,
        runId: request.runId,
      });
      if (resultado.instalados.length === 0) {
        throw new Error(
          `Todos los servidores propuestos ya están configurados: ${resultado.yaExistian.join(", ")}. ` +
            `No hay nada que aprobar; si al agente le faltan sus herramientas, va a pedirlas aparte.`,
        );
      }
      return {
        servidores: resultado.instalados,
        ...(resultado.yaExistian.length > 0 ? { yaExistian: resultado.yaExistian } : {}),
        estado: resultado.estado,
        herramientasOtorgadas: resultado.herramientasOtorgadas,
        ...(resultado.avisos.length > 0 ? { avisos: resultado.avisos } : {}),
      };
    }

    return {}; // `context`: la respuesta viaja en el mensaje, no cambia config
  }

  /**
   * Instala servidores MCP de punta a punta: dedupe por nombre, chequeo de
   * variables requeridas, alta en la base, sync **esperando el handshake**,
   * descubrimiento de herramientas y otorgamiento opcional a un rol.
   *
   * Es el ciclo que ya hacía la aprobación de solicitudes, extraído para que
   * la tienda y el CRUD lo reusen: instalar desde cualquier lado tiene que
   * conectar de verdad y poder decir "conectado, N herramientas", no "se
   * guardó una configuración".
   */
  async instalarServidoresMcp(
    companyId: string,
    servidores: Array<{
      name: string;
      description: string;
      transport: McpServer["transport"];
      envRequeridas?: McpServer["envRequeridas"];
      catalogoId?: string | null;
    }>,
    opciones: { otorgarARolId?: string | null; runId?: string | null } = {},
  ): Promise<{
    instalados: string[];
    yaExistian: string[];
    estado: string[];
    toolCount: number;
    toolNames: string[];
    herramientasOtorgadas: string[];
    avisos: string[];
  }> {
    const avisos: string[] = [];

    // Los repetidos no son un error —la capacidad ya está—, pero se informan:
    // instalar dos veces el mismo nombre rompería los ids `mcp__<name>__<tool>`.
    const existentes = new Set(this.store.listMcpServers(companyId).map((server) => server.name));
    const nuevos = servidores.filter((server) => !existentes.has(server.name));
    const yaExistian = servidores
      .filter((server) => existentes.has(server.name))
      .map((server) => server.name);

    for (const servidor of nuevos) {
      // Un faltante no frena la instalación —la credencial la carga la persona
      // por su lado— pero se dice acá, cerca de la causa, no en un handshake
      // fallido de dentro de un rato.
      const requeridas = servidor.envRequeridas ?? [];
      const faltantes = requeridas
        .filter((entrada) => entrada.obligatoria && !resolveSecret(entrada.ref))
        .map((entrada) => entrada.ref);
      if (faltantes.length > 0) {
        avisos.push(
          `"${servidor.name}" necesita ${faltantes.join(", ")} y no está en el entorno: ` +
            `agregala al .env del servidor y reconectá.`,
        );
      }

      this.store.saveMcpServer(
        mcpServerSchema.parse({
          id: ids.mcpServer(),
          companyId,
          name: servidor.name,
          description: servidor.description,
          transport: servidor.transport,
          enabled: true,
          autoApproveTools: true,
          envRequeridas: requeridas,
          catalogoId: servidor.catalogoId ?? null,
        }),
      );
    }

    if (nuevos.length === 0) {
      return {
        instalados: [],
        yaExistian,
        estado: [],
        toolCount: 0,
        toolNames: [],
        herramientasOtorgadas: [],
        avisos,
      };
    }

    // Conectar es sincronizar contra la base, que ya tiene los nuevos. El
    // handshake se espera acá para poder responder qué herramientas
    // aparecieron.
    const runtime = await this.companyRuntime(companyId);
    this.persistMcpTools(companyId, runtime.tools);

    const idsNuevos = new Set(
      this.store
        .listMcpServers(companyId)
        .filter((server) => nuevos.some((propuesto) => propuesto.name === server.name))
        .map((server) => server.id),
    );
    const descubiertas = this.store
      .listTools(companyId)
      .filter((tool) => tool.mcpServerId != null && idsNuevos.has(tool.mcpServerId));

    // Lo pedido se otorga: un servidor aprobado cuyas herramientas no le
    // llegan a nadie deja al solicitante igual de bloqueado que antes.
    let otorgadas: string[] = [];
    if (opciones.otorgarARolId) {
      const rol = this.store
        .listRoles(companyId)
        .find((candidate) => candidate.id === opciones.otorgarARolId);
      if (rol) {
        const toolIds = [...new Set([...rol.toolIds, ...descubiertas.map((tool) => tool.id)])];
        this.store.saveRole({ ...rol, toolIds });
        otorgadas = descubiertas.map((tool) => tool.name);

        // La corrida viva congela su catálogo al arrancar: las herramientas
        // nuevas hay que sumárselas explícitamente o el agente que las pidió
        // no las ve hasta la corrida siguiente.
        const enCurso = opciones.runId ? this.runs.get(opciones.runId) : undefined;
        if (enCurso) {
          for (const tool of descubiertas) enCurso.state.incorporarHerramienta(tool, null);
          enCurso.state.updateRoleTools(rol.id, toolIds);
        }
      }
    }

    const estado = this.mcpHealth(companyId)
      .filter((salud) => idsNuevos.has(salud.serverId))
      .map((salud) => `${salud.serverName}: ${salud.status}`);

    return {
      instalados: nuevos.map((server) => server.name),
      yaExistian,
      estado,
      toolCount: descubiertas.length,
      toolNames: descubiertas.map((tool) => tool.name),
      herramientasOtorgadas: otorgadas,
      avisos,
    };
  }

  /**
   * Lleva a las corridas vivas un rol que se editó desde la configuración.
   *
   * La corrida congela el organigrama y el catálogo al arrancar. Para el
   * borrado ya estaba resuelto (`removeRoleFromLiveRuns`); para la edición no,
   * y ahí el síntoma es peor porque nada falla: se instala un servidor MCP
   * desde la tienda, se le asignan sus herramientas a los roles, la base queda
   * impecable y los agentes siguen sin verlas. Lo medimos con Brave conectado
   * y `ready`, con las dos tools otorgadas a los tres roles, y una corrida
   * entera insistiendo con `web_search` —que su proveedor no soporta— sin una
   * sola invocación al servidor que tenía al lado.
   *
   * Las herramientas nuevas entran al catálogo de la corrida antes de otorgar:
   * un `toolIds` que apunta a algo que la corrida no tiene en catálogo no le
   * agrega nada al agente. Lo *ejecutable* ya está —el registry es el de la
   * empresa, compartido con la corrida—, lo que faltaba era el catálogo.
   */
  actualizarRolEnCorridasVivas(companyId: string, role: Role): number {
    const catalogo = this.store.listTools(companyId);
    let alcanzadas = 0;

    for (const active of this.runs.values()) {
      if (active.companyId !== companyId) continue;
      if (!active.state.roles.some((candidate) => candidate.id === role.id)) continue;

      const conocidas = new Set(active.state.tools.map((tool) => tool.id));
      const nuevas = catalogo.filter(
        (tool) => role.toolIds.includes(tool.id) && !conocidas.has(tool.id),
      );
      for (const tool of nuevas) active.state.incorporarHerramienta(tool, null);
      if (!active.state.actualizarRol(role)) continue;
      alcanzadas++;

      if (nuevas.length > 0) {
        active.bus.emit({
          type: "log",
          level: "info",
          runId: active.run.id,
          tick: active.run.tick,
          roleId: role.id,
          message:
            `${role.name} recibe ${nuevas.length} herramienta(s) desde la configuración y las ` +
            `tiene en su próximo turno: ${nuevas.map((tool) => tool.name).join(", ")}.`,
        });
      }
    }
    return alcanzadas;
  }

  /**
   * Retira un rol borrado de las corridas de esa empresa que sigan vivas.
   *
   * Sin esto el borrado solo afecta a la configuración: la corrida en curso
   * cargó los roles al arrancar, así que el agente eliminado seguiría tomando
   * turnos, gastando presupuesto y abriendo solicitudes nuevas —justo las que
   * el borrado acaba de limpiar—.
   */
  removeRoleFromLiveRuns(companyId: string, roleId: string, roleName: string): number {
    let alcanzadas = 0;
    for (const active of this.runs.values()) {
      if (active.companyId !== companyId) continue;
      if (!active.state.roles.some((role) => role.id === roleId)) continue;
      active.state.removeRole(roleId);
      alcanzadas++;
      active.bus.emit({
        type: "log",
        level: "warn",
        runId: active.run.id,
        tick: active.run.tick,
        roleId: null,
        message: `${roleName} fue eliminado desde la configuración y sale de la corrida.`,
      });
    }
    return alcanzadas;
  }

  /**
   * Le hace llegar la respuesta al agente que preguntó.
   *
   * Si su corrida sigue viva le entra por la bandeja. Si ya terminó —que es el
   * caso normal: uno contesta la bandeja después de mirar la corrida— la
   * respuesta se guarda como memoria de la empresa, que sí se inyecta en el
   * prompt de todas las corridas siguientes. Sin esto lo que contestás se
   * pierde en silencio y el agente vuelve a preguntar lo mismo en la próxima,
   * gastando tokens en algo ya resuelto.
   *
   * Devuelve cómo se entregó, para poder decírselo a quien contestó.
   */
  notifyRequester(
    request: AgentRequest,
    aplicado: Record<string, unknown>,
  ): "bandeja" | "memoria" | "descartada" {
    if (!request.requestedByRoleId) return "descartada";
    let active = request.runId ? this.runs.get(request.runId) : undefined;

    // Las solicitudes pendientes se **heredan**: una corrida nueva las carga de
    // la configuración de la empresa al arrancar. Si la corrida que la creó ya
    // no está viva, la respuesta tiene que espejarse en la que la está
    // esperando ahora — sin esto, esa corrida queda en `awaiting_approval` para
    // siempre por una solicitud que ya está resuelta en la base. Lo medimos:
    // una corrida entera con el trabajo aprobado, trabada en su cierre.
    if (!active) {
      active = [...this.runs.values()].find(
        (candidata) =>
          candidata.companyId === request.companyId &&
          candidata.state.requests.some(
            (pendiente) => pendiente.id === request.id && pendiente.status === "pending",
          ),
      );
      // La reanudación de la ruta apunta al runId original, que acá no sirve:
      // se dispara sobre la corrida que de verdad estaba esperando.
      if (active) {
        const heredera = active.run.id;
        queueMicrotask(() => this.reanudarSiEsperaba(heredera));
      }
    }

    if (!active) {
      if (request.type !== "context" || !request.resolution?.trim()) return "descartada";
      const now = Date.now();
      const autor = this.store
        .listRoles(request.companyId)
        .find((role) => role.id === request.requestedByRoleId);
      const pregunta = request.question ?? request.reason;
      const respuesta = request.resolution.trim();

      // La respuesta entra **recortada**: esta puerta metía respuestas de
      // 5.570 caracteres como lecciones, y la memoria viaja en el prompt de
      // cada turno — medimos que llegó a ser el 54% del prompt. Si la
      // respuesta es larga, la versión completa va al vault, que existe justo
      // para lo que no puede viajar en cada turno, y la lección apunta ahí.
      const TOPE_RESPUESTA = 600;
      const larga = respuesta.length > TOPE_RESPUESTA;
      if (larga) {
        const company = this.store.getCompany(request.companyId);
        if (company) {
          void this.contexto
            .escribir(
              { id: company.id, nombre: company.name },
              `Consultas/${pregunta.slice(0, 60)}.md`,
              `# ${pregunta}\n\n${respuesta}\n`,
            )
            .catch((error: unknown) => {
              console.error("no se pudo guardar la respuesta completa en el vault:", error);
            });
        }
      }
      this.store.saveLearning({
        id: ids.learning(),
        companyId: request.companyId,
        topic: `consulta: ${pregunta}`.slice(0, 120),
        lesson:
          `Pregunta de ${autor?.name ?? "un agente"}: ${pregunta}\n\n` +
          `Respuesta: ${respuesta.slice(0, TOPE_RESPUESTA)}` +
          (larga ? `\n\n(La respuesta completa está en el vault, bajo Consultas.)` : ""),
        authorRoleId: null,
        runId: request.runId,
        timesConfirmed: 1,
        // Procedencia honesta, sin gate: la escribió una persona.
        evidencia: "respuesta de la persona a cargo a una consulta",
        estado: "activa",
        refutacion: null,
        confirmaciones: [],
        createdAt: now,
        updatedAt: now,
      });
      return "memoria";
    }

    // La copia en memoria de la corrida tiene que enterarse: es la que mira el
    // scheduler para saber si todavía espera a alguien.
    active.state.resolverSolicitud(request);

    const aprobada = request.status === "approved";

    // Una pregunta se contesta con una respuesta, no con un permiso.
    //
    // Todo salía como `approval_grant` con el asunto "Tu solicitud fue
    // aprobada", así que un agente que había preguntado "¿cuántas consultas
    // reciben por mes?" recibía algo rotulado "Aprobación concedida" con los
    // datos escondidos en el cuerpo. Lo medimos: leyó el mensaje y volvió a
    // preguntar tres de las mismas cosas en el ciclo siguiente.
    if (request.type === "context") {
      const pregunta = request.question ?? request.reason;
      void active.state.forActor(null).sendMessage({
        toRoleId: request.requestedByRoleId,
        toDepartmentId: null,
        type: aprobada ? "response" : "approval_deny",
        subject: aprobada
          ? `Respuesta a: ${pregunta.slice(0, 120)}`
          : "No hay respuesta para tu consulta",
        // El dato primero: es lo que el agente vino a buscar. La pregunta va
        // al final, como referencia de qué se estaba contestando.
        body: aprobada
          ? `${request.resolution ?? ""}\n\n---\nEsto responde tu consulta: "${pregunta}"\n` +
            `Ya lo tenés: no lo vuelvas a preguntar.`
          : `Tu consulta no fue respondida.\n\n${request.resolution ?? ""}`,
        threadId: null,
        inReplyTo: null,
      });
      return "bandeja";
    }

    // Una instalación se cuenta como lo que es: qué quedó instalado y cómo se
    // usa desde el código, no un volcado de JSON.
    if (request.type === "dependencia" && request.dependencia) {
      const paquetes = request.dependencia.paquetes.join(", ");
      void active.state.forActor(null).sendMessage({
        toRoleId: request.requestedByRoleId,
        toDepartmentId: null,
        type: aprobada ? "approval_grant" : "approval_deny",
        subject: aprobada ? `Instalado: ${paquetes}` : `No se instaló: ${paquetes}`,
        body: aprobada
          ? `Quedó instalado ${paquetes} en node_modules y anotado en package.json` +
            `${typeof aplicado["checkpoint"] === "string" ? ` (checkpoint ${String(aplicado["checkpoint"]).slice(0, 8)})` : ""}. ` +
            `Importalo por su nombre de paquete; en una página sin build, apuntá el import map a ./node_modules/<paquete>/…` +
            `\n\nSalida del gestor:\n${String(aplicado["salida"] ?? "")}`
          : `La persona no aprobó instalar ${paquetes}.\n\n${request.resolution ?? ""}\n\nBuscá una alternativa sin esa dependencia o explicá por qué hace falta.`,
        threadId: null,
        inReplyTo: null,
      });
      return "bandeja";
    }

    const detalle = aprobada ? `Aplicado: ${JSON.stringify(aplicado)}` : (request.resolution ?? "");

    void active.state.forActor(null).sendMessage({
      toRoleId: request.requestedByRoleId,
      toDepartmentId: null,
      type: aprobada ? "approval_grant" : "approval_deny",
      subject: aprobada ? "Tu solicitud fue aprobada" : "Tu solicitud fue rechazada",
      body:
        `Pedido: ${request.reason}\n\n${detalle}` +
        (request.type === "create_role" && aprobada
          ? `\n\nYa está incorporado y disponible desde el próximo ciclo: escribile con ` +
            `send_message para ponerlo a trabajar.`
          : "") +
        (request.type === "mcp_server" && aprobada
          ? `\n\nEl servidor ya está conectado y sus herramientas te quedaron asignadas: ` +
            `las vas a ver en tu próximo turno. Si alguna necesita una credencial que ` +
            `se descartó al importar, la persona a cargo la carga en el .env del servidor.`
          : ""),
      threadId: null,
      inReplyTo: null,
    });
    return "bandeja";
  }

  // --- Suscripciones SSE ---------------------------------------------------

  subscribeRun(runId: string, sink: EventSink): () => void {
    let set = this.runSubscribers.get(runId);
    if (!set) {
      set = new Set();
      this.runSubscribers.set(runId, set);
    }
    set.add(sink);
    return () => set.delete(sink);
  }

  subscribeCodigo(companyId: string, sink: (evento: EventoDeCodigo) => void): () => void {
    const sinks = this.codigoSubscribers.get(companyId) ?? new Set();
    sinks.add(sink);
    this.codigoSubscribers.set(companyId, sinks);
    return () => sinks.delete(sink);
  }

  private broadcastCodigo(evento: EventoDeCodigo): void {
    for (const sink of this.codigoSubscribers.get(evento.companyId) ?? []) {
      try {
        sink(evento);
      } catch {
        // Un suscriptor caído no puede cortar a los demás.
      }
    }
  }

  subscribeMcp(sink: (health: McpServerHealth) => void): () => void {
    this.mcpSubscribers.add(sink);
    return () => this.mcpSubscribers.delete(sink);
  }

  private broadcastRun(runId: string, event: TraceEvent): void {
    for (const sink of this.runSubscribers.get(runId) ?? []) {
      try {
        sink(event);
      } catch {
        // Una conexión SSE caída no puede tumbar la corrida.
      }
    }
  }

  private broadcastMcp(health: McpServerHealth): void {
    for (const sink of this.mcpSubscribers) {
      try {
        sink(health);
      } catch {
        // idem
      }
    }
  }

  async shutdown(): Promise<void> {
    this.servicios.detenerTodos();
    for (const active of this.runs.values()) active.orchestrator.stop("Servidor detenido.");
    await Promise.all([...this.companies.values()].map((runtime) => runtime.mcp.disconnectAll()));
  }
}
