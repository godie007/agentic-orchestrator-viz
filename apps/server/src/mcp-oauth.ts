import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServer } from "@orq/shared";
import type { FabricaOAuth } from "@orq/tools";

/**
 * OAuth para servidores MCP remotos, como lo hace `claude mcp add --transport
 * http`: el MCP de Supabase, el de Sentry. La primera vez el Hub ofrece
 * "Autorizar", la persona inicia sesión en el navegador y vuelve a
 * `/api/mcp/oauth/callback`; después los tokens se renuevan solos.
 *
 * **Los tokens no van a la base.** Viven en un archivo por servidor
 * (`data/mcp-oauth/<id>.json`, sólo legible por el usuario), por la misma
 * regla que los secretos de MCP se guardan por referencia: una empresa
 * exportada a JSON no puede llevarse una credencial adentro. Borrar el
 * servidor borra su archivo.
 */

interface Guardado {
  cliente?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verificador?: string;
}

class ProveedorEnArchivo implements OAuthClientProvider {
  private datos: Guardado;
  private estado: string | null = null;

  constructor(
    private readonly archivo: string,
    private readonly vuelta: string,
    private readonly alPedir: (url: URL) => void,
  ) {
    try {
      this.datos = JSON.parse(readFileSync(archivo, "utf8")) as Guardado;
    } catch {
      this.datos = {};
    }
  }

  private guardar(): void {
    writeFileSync(this.archivo, JSON.stringify(this.datos), { encoding: "utf8", mode: 0o600 });
  }

  get redirectUrl(): string {
    return this.vuelta;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Orquestador Agéntico",
      redirect_uris: [this.vuelta],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** Único por pedido: es lo que ata la vuelta del navegador a este servidor. */
  state(): string {
    this.estado ??= randomBytes(16).toString("hex");
    return this.estado;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.datos.cliente;
  }

  saveClientInformation(cliente: OAuthClientInformationMixed): void {
    this.datos.cliente = cliente;
    this.guardar();
  }

  tokens(): OAuthTokens | undefined {
    return this.datos.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.datos.tokens = tokens;
    delete this.datos.verificador;
    this.guardar();
  }

  redirectToAuthorization(url: URL): void {
    // No hay navegador que abrir desde el servidor: la URL va a la salud del
    // servidor y el Hub la ofrece como botón.
    this.alPedir(url);
  }

  saveCodeVerifier(verificador: string): void {
    this.datos.verificador = verificador;
    this.guardar();
  }

  codeVerifier(): string {
    if (!this.datos.verificador) throw new Error("No hay un pedido de autorización en curso.");
    return this.datos.verificador;
  }

  invalidateCredentials(alcance: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (alcance === "all" || alcance === "client") delete this.datos.cliente;
    if (alcance === "all" || alcance === "tokens") delete this.datos.tokens;
    if (alcance === "all" || alcance === "verifier") delete this.datos.verificador;
    this.guardar();
  }
}

export function crearFabricaOAuth(directorio: string, vuelta: string): FabricaOAuth {
  return (server: McpServer, alPedir: (url: URL) => void) => {
    mkdirSync(directorio, { recursive: true, mode: 0o700 });
    return new ProveedorEnArchivo(archivoDe(directorio, server.id), vuelta, alPedir);
  };
}

/** Al borrar el servidor, su credencial se va con él. */
export function olvidarOAuth(directorio: string, serverId: string): void {
  const archivo = archivoDe(directorio, serverId);
  if (existsSync(archivo)) rmSync(archivo, { force: true });
}

function archivoDe(directorio: string, serverId: string): string {
  return join(directorio, `${serverId.replace(/[^a-z0-9_-]/gi, "")}.json`);
}
