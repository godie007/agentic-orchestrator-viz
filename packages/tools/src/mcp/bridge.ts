import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

interface Connection {
  server: McpServer;
  client: Client | null;
  health: McpServerHealth;
  /** Timer de reintento pendiente, para poder cancelarlo al desconectar. */
  retryTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

export class McpBridge {
  private connections = new Map<string, Connection>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly resolveSecret: SecretResolver,
    private readonly onStatus: McpStatusListener,
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
    };
    const conn: Connection = { server, client: null, health, retryTimer: null, closed: false };
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
      await client.connect(this.buildTransport(conn.server));
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
      const message = error instanceof Error ? error.message : String(error);
      conn.health.errors += 1;
      this.scheduleReconnect(conn, message);
    }
  }

  private buildTransport(server: McpServer) {
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
    return new StreamableHTTPClientTransport(new URL(server.transport.url), {
      requestInit: { headers },
      // Con CA declarada se verifica contra ella; sin ella, contra las del
      // sistema. En ningún caso se apaga la verificación.
      ...(caPath ? { fetch: fetchConCa(caPath) } : {}),
    });
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
        // MCP no declara si una tool es de solo lectura, así que se asume que
        // muta: ejecutarlas en serie es más lento pero no rompe nada.
        readOnly: false,
        requiresApproval: !conn.server.autoApproveTools,
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
