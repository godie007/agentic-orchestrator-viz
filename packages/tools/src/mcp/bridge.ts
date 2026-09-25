import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { fetchConCa } from "./ca-fetch.js";
import type { McpServer, McpServerHealth, McpConnectionStatus } from "@orq/shared";
import { fail, ok, preview, type RegisteredTool } from "../types.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Puente MCP.
 *
 * No se limita a conectar: mantiene y publica el estado de cada servidor
 * —semáforo, latencia del handshake, tools descubiertas, invocaciones y
 * errores— porque esa telemetría es lo que dibuja el MCP Hub. Un servidor que
 * se cae, se reconecta o falla una llamada tiene que verse en la pantalla, no
 * quedar en un log.
 */

export type McpStatusListener = (health: McpServerHealth) => void;

/** Cómo se resuelven los secretos: el nombre de la variable → su valor. */
export type SecretResolver = (envVarName: string) => string | undefined;

/**
 * Da el proveedor OAuth de un servidor HTTP, o `null` si no corresponde. Lo
 * inyecta el servidor —que decide dónde se guardan los tokens—, igual que
 * `resolveSecret`: `packages/tools` no sabe de rutas. `alPedir` se llama con la
 * URL de autorización cuando el servidor exige iniciar sesión.
 */
export type FabricaOAuth = (server: McpServer, alPedir: (url: URL) => void) => OAuthClientProvider | null;

interface Connection {
  server: McpServer;
  client: Client | null;
  health: McpServerHealth;
  /** Timer de reintento pendiente, para poder cancelarlo al desconectar. */
  retryTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** Turnero del servidor: sus llamadas van de a una. Ver `crearFila`. */
  fila: Fila;
  /** El transporte HTTP en curso: `finishAuth` tiene que llamarse sobre éste. */
  transporte: StreamableHTTPClientTransport | null;
}

/** Encola trabajo: devuelve el resultado de cada tarea, corriéndolas de a una. */
export type Fila = <T>(tarea: () => Promise<T>) => Promise<T>;

/**
 * Un servidor MCP atiende **de a una llamada por vez**.
 *
 * El motor corre varios agentes en paralelo dentro de un ciclo y todos ven el
 * mismo servidor. Con un servidor sin estado eso no molesta; con uno que maneja
 * **un recurso compartido** rompe todo: dos agentes navegando el mismo navegador
 * al mismo tiempo se pisan la pestaña, y el que llegó segundo lee la página del
 * primero creyendo que es la suya. Es la peor clase de falla — no da error, da
 * un dato equivocado con aspecto de correcto.
 *
 * La fila es **por servidor** y no global: dos servidores distintos siguen
 * corriendo en paralelo. Lo que se serializa es el acceso a un mismo proceso,
 * que es exactamente el recurso que no se puede compartir.
 */
export function crearFila(): Fila {
  let ultima: Promise<unknown> = Promise.resolve();
  return <T,>(tarea: () => Promise<T>): Promise<T> => {
    // Se encadena tanto en éxito como en error: si una llamada falla y la fila
    // se cortara, todos los que esperan turno se quedarían sin él.
    const propia = ultima.then(tarea, tarea);
    ultima = propia.catch(() => undefined);
    return propia;
  };
}

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Reintentos ante un límite de tasa del servicio de atrás, y cuánto se espera.
 *
 * La fila serializa las llamadas pero no las **espacia**: dos búsquedas de dos
 * agentes salen una detrás de la otra y, si la primera contesta en medio
 * segundo, las dos caen dentro del mismo segundo. Con Brave en plan Free —una
 * consulta por segundo— eso es un 429 garantizado: lo medimos con dos llamadas
 * estampadas en el mismo segundo, la primera con resultados y la segunda
 * rechazada. Esperar dentro de la fila es lo correcto y no un efecto
 * colateral: frena a los demás de **ese** servidor, que es justo lo que pide
 * un límite por segundo, y no toca a los otros.
 *
 * Dos reintentos y no más: si el límite es de cuota diaria y no de tasa,
 * insistir no lo arregla y lo único que hace es demorar el turno del resto.
 */
const REINTENTOS_POR_LIMITE = 2;
const ESPERA_POR_LIMITE_MS = 1_100;
const MAX_ESPERA_POR_LIMITE_MS = 15_000;

/**
 * Si el error de una llamada es un límite de tasa.
 *
 * Se mira el **texto** porque un servidor MCP no tiene forma de devolver un
 * código: lo que llega es el mensaje que el servidor armó con la respuesta de
 * su API. Por eso se buscan las tres formas en que aparece, y no una sola.
 */
export function esLimiteDeTasa(texto: string): boolean {
  return /\b429\b/.test(texto) || /rate.?limit/i.test(texto) || /too many requests/i.test(texto);
}

/**
 * Cuánto esperar antes de reintentar, en milisegundos.
 *
 * Si el servicio dijo cuánto —`retry-after: 3`, `"retryAfter": 3`— se le hace
 * caso: nadie sabe mejor que él cuándo vuelve a atender. El valor se toma en
 * segundos, que es como lo publica HTTP, y se acota para que un `retry-after`
 * enorme (o disparatado) no deje la fila del servidor congelada.
 */
export function esperaDeReintento(texto: string, intento: number): number {
  const declarado = /retry[-_ ]?after"?\s*[:=]\s*"?(\d+)/i.exec(texto);
  if (declarado?.[1]) {
    return Math.min(Number(declarado[1]) * 1000, MAX_ESPERA_POR_LIMITE_MS);
  }
  return Math.min(ESPERA_POR_LIMITE_MS * intento, MAX_ESPERA_POR_LIMITE_MS);
}

const dormir = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class McpBridge {
  private connections = new Map<string, Connection>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly resolveSecret: SecretResolver,
    private readonly onStatus: McpStatusListener,
    private readonly oauth: FabricaOAuth | null = null,
  ) {}

  /** Estado actual de todos los servidores, para pintar el Hub al abrirlo. */
  health(): McpServerHealth[] {
    return [...this.connections.values()].map((conn) => ({ ...conn.health }));
  }

  healthOf(serverId: string): McpServerHealth | undefined {
    const conn = this.connections.get(serverId);
    return conn ? { ...conn.health } : undefined;
  }

  /**
   * Sincroniza las conexiones con la configuración: levanta las nuevas, baja
   * las que se quitaron y reconecta las que cambiaron de transporte.
   */
  async sync(servers: readonly McpServer[]): Promise<void> {
    const desired = new Map(servers.map((server) => [server.id, server]));

    for (const [id, conn] of this.connections) {
      const next = desired.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(conn.server)) {
        await this.disconnect(id);
      }
    }

    await Promise.all(
      servers.map((server) =>
        this.connections.has(server.id) ? Promise.resolve() : this.connect(server),
      ),
    );
  }

  async connect(server: McpServer): Promise<void> {
    // El uso acumulado sobrevive a la reconexión. Reiniciarlo hacía que el Hub
    // —cuya razón de ser es mostrar qué se usó— dijera "0 invocaciones" después
    // de una corrida que había hecho decenas: cualquier reconexión, y una caída
    // del transporte provoca una, borraba la evidencia.
    const previa = this.connections.get(server.id)?.health;
    await this.disconnect(server.id);

    const health: McpServerHealth = {
      serverId: server.id,
      serverName: server.name,
      status: server.enabled ? "connecting" : "disabled",
      handshakeMs: null,
      toolCount: 0,
      invocations: previa?.invocations ?? 0,
      errors: previa?.errors ?? 0,
      lastError: previa?.lastError ?? null,
      lastInvokedAt: previa?.lastInvokedAt ?? null,
      connectedAt: null,
      reconnectAttempts: 0,
      // Las referencias sin valor se declaran acá, no se omiten en silencio:
      // el Hub y la tienda tienen que poder decir "falta GITHUB_TOKEN" antes
      // de que el handshake falle con un error de auth ajeno.
      envFaltantes: this.referenciasSinValor(server),
      autorizacion: null,
    };
    const conn: Connection = {
      server,
      client: null,
      health,
      retryTimer: null,
      closed: false,
      fila: crearFila(),
      transporte: null,
    };
    this.connections.set(server.id, conn);
    this.publish(conn);

    if (!server.enabled) return;
    await this.open(conn);
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    conn.closed = true;
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    this.registry.unregisterByMcpServer(serverId);
    try {
      await conn.client?.close();
    } catch {
      // Cerrar un transporte ya muerto no es un problema que reportar.
    }
    this.connections.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private async open(conn: Connection): Promise<void> {
    const startedAt = Date.now();
    try {
      const client = new Client(
        { name: "orquestador-agentico", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(this.buildTransport(conn));
      if (conn.closed) {
        await client.close();
        return;
      }

      conn.client = client;
      conn.health.handshakeMs = Date.now() - startedAt;
      conn.health.connectedAt = Date.now();
      conn.health.reconnectAttempts = 0;
      conn.health.lastError = null;

      const tools = await this.discover(conn, client);
      conn.health.toolCount = tools;
      this.setStatus(conn, "ready");

      // Un servidor puede morir después del handshake (proceso que crashea,
      // HTTP que se cae). Sin esto el Hub quedaría en verde mintiendo.
      client.onclose = () => {
        if (conn.closed) return;
        this.registry.unregisterByMcpServer(conn.server.id);
        conn.health.toolCount = 0;
        this.scheduleReconnect(conn, "la conexión se cerró");
      };
    } catch (error) {
      // Falta que una persona autorice: reintentar solo no sirve de nada —el
      // servidor va a decir que no hasta que alguien inicie sesión—. Se queda
      // esperando la vuelta del navegador (`completarAutorizacion`).
      if (error instanceof UnauthorizedError || conn.health.autorizacion) {
        conn.health.lastError = conn.health.autorizacion
          ? "Falta autorizar el acceso: abrí el enlace de autorización e iniciá sesión."
          : `El servidor rechazó la autorización: ${error instanceof Error ? error.message : String(error)}`;
        this.setStatus(conn, "error");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      conn.health.errors += 1;
      this.scheduleReconnect(conn, message);
    }
  }

  /**
   * La vuelta del navegador después de autorizar: se canjea el código en el
   * mismo transporte que pidió la autorización y se vuelve a conectar. Se
   * reconoce la conexión por el `state` de la URL, que es único por pedido.
   */
  async completarAutorizacion(estado: string, codigo: string): Promise<{ serverId: string; nombre: string } | null> {
    for (const conn of this.connections.values()) {
      const pedido = conn.health.autorizacion;
      if (!pedido || !conn.transporte) continue;
      if (new URL(pedido).searchParams.get("state") !== estado) continue;
      await conn.transporte.finishAuth(codigo);
      conn.health.autorizacion = null;
      conn.health.lastError = null;
      this.setStatus(conn, "connecting");
      await this.open(conn);
      return { serverId: conn.server.id, nombre: conn.server.name };
    }
    return null;
  }

  /** Referencias de env/headers del transporte que no resuelven a un valor. */
  private referenciasSinValor(server: McpServer): string[] {
    const refs =
      server.transport.type === "stdio"
        ? Object.values(server.transport.envRefs)
        : Object.values(server.transport.headerRefs);
    return [...new Set(refs.filter((ref) => this.resolveSecret(ref) == null))];
  }

  private buildTransport(conn: Connection) {
    const server = conn.server;
    if (server.transport.type === "stdio") {
      const env: Record<string, string> = {};
      for (const [key, envVar] of Object.entries(server.transport.envRefs)) {
        const value = this.resolveSecret(envVar);
        // Un secreto faltante se omite: el servidor fallará con su propio
        // mensaje de auth, que es más útil que un error genérico nuestro.
        if (value != null) env[key] = value;
      }
      return new StdioClientTransport({
        command: server.transport.command,
        args: server.transport.args,
        env,
        ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      });
    }

    const headers: Record<string, string> = {};
    for (const [header, envVar] of Object.entries(server.transport.headerRefs)) {
      const value = this.resolveSecret(envVar);
      if (value != null) headers[header] = value;
    }
    const { caPath } = server.transport;
    // Sin cabeceras de credencial declaradas, el servidor puede pedir OAuth
    // (el MCP remoto de Supabase, el de Sentry): se ofrece un proveedor y, si
    // lo usa, la URL para iniciar sesión queda en la salud para el Hub.
    const proveedor =
      Object.keys(server.transport.headerRefs).length === 0
        ? (this.oauth?.(server, (url) => {
            conn.health.autorizacion = url.toString();
          }) ?? null)
        : null;
    const transporte = new StreamableHTTPClientTransport(new URL(server.transport.url), {
      requestInit: { headers },
      ...(proveedor ? { authProvider: proveedor } : {}),
      // Con CA declarada se verifica contra ella; sin ella, contra las del
      // sistema. En ningún caso se apaga la verificación.
      ...(caPath ? { fetch: fetchConCa(caPath) } : {}),
    });
    conn.transporte = transporte;
    return transporte;
  }

  /** Descubre las tools del servidor y las publica en el registro. */
  private async discover(conn: Connection, client: Client): Promise<number> {
    const response = await client.listTools();
    let count = 0;

    for (const tool of response.tools) {
      const qualified = `mcp__${conn.server.name}__${tool.name}`;
      const registered: RegisteredTool = {
        name: qualified,
        origin: "mcp",
        mcpServerId: conn.server.id,
        description: tool.description ?? `Herramienta ${tool.name} de ${conn.server.name}`,
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
        // Sólo se cree la declaración explícita del servidor
        // (`readOnlyHint`); sin ella se asume que muta. Con aprobación manual,
        // lo de sólo lectura corre solo y lo que escribe espera a una persona.
        readOnly: tool.annotations?.readOnlyHint === true,
        requiresApproval: !conn.server.autoApproveTools && tool.annotations?.readOnlyHint !== true,
        execute: async (args, ctx) => this.invoke(conn, tool.name, qualified, args, ctx.signal),
      };
      this.registry.register(registered);
      count++;
    }
    return count;
  }

  /** Ejecuta una tool del servidor y contabiliza el resultado en la salud. */
  private async invoke(
    conn: Connection,
    toolName: string,
    qualifiedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!conn.client || conn.health.status !== "ready") {
      return fail(
        `El servidor MCP "${conn.server.name}" no está conectado (estado: ${conn.health.status}). ` +
          `Reintentá más tarde o resolvé el problema desde el MCP Hub.`,
      );
    }

    // El reintento va **dentro** de la fila: si esperara afuera, otra llamada
    // entraría en el hueco y volvería a chocar contra el mismo límite.
    return conn.fila(async () => {
      let ultimo = await this.llamar(conn, toolName, qualifiedName, args, signal);

      for (let intento = 1; intento <= REINTENTOS_POR_LIMITE; intento++) {
        if (ultimo.ok || !esLimiteDeTasa(ultimo.content)) break;
        if (signal?.aborted) break;
        await dormir(esperaDeReintento(ultimo.content, intento));
        ultimo = await this.llamar(conn, toolName, qualifiedName, args, signal);
      }

      return ultimo;
    });
  }

  private async llamar(
    conn: Connection,
    toolName: string,
    qualifiedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!conn.client) {
      return fail(`El servidor MCP "${conn.server.name}" se desconectó mientras esperaba turno.`);
    }

    conn.health.invocations += 1;
    conn.health.lastInvokedAt = Date.now();
    this.publish(conn);

    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { ...(signal ? { signal } : {}), timeout: 60_000 },
      );

      const text = extractText(result.content);
      if (result.isError) {
        conn.health.errors += 1;
        conn.health.lastError = preview(text, 200);
        this.publish(conn);
        return fail(`${qualifiedName}: ${text}`);
      }
      return ok(text, preview(text, 200));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conn.health.errors += 1;
      conn.health.lastError = message;
      this.publish(conn);
      return fail(`${qualifiedName} falló: ${message}`);
    }
  }

  /**
   * Backoff exponencial con techo. Sin techo, un servidor caído desde hace
   * horas tardaría días en reintentar; con techo reintenta cada minuto y el
   * Hub muestra el contador de intentos.
   */
  private scheduleReconnect(conn: Connection, reason: string): void {
    if (conn.closed) return;

    conn.client = null;
    conn.health.lastError = reason;
    conn.health.reconnectAttempts += 1;
    this.setStatus(conn, "reconnecting");

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** (conn.health.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    conn.retryTimer = setTimeout(() => {
      void this.open(conn);
    }, delay);
    // No debe mantener vivo el proceso si es lo único pendiente.
    conn.retryTimer.unref?.();
  }

  private setStatus(conn: Connection, status: McpConnectionStatus): void {
    conn.health.status = status;
    this.publish(conn);
  }

  private publish(conn: Connection): void {
    this.onStatus({ ...conn.health });
  }
}

/** Aplana el contenido MCP a texto: es lo único que el modelo puede leer. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource") {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (typeof resource?.text === "string") parts.push(resource.text);
      else parts.push(`[recurso ${String(resource?.uri ?? "sin uri")}]`);
    } else if (block.type === "image") {
      parts.push("[imagen: el agente no puede verla en este contexto]");
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n").trim();
}
