import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@orq/shared";
import { crearFabricaOAuth, olvidarOAuth } from "./mcp-oauth.js";

/**
 * La credencial OAuth de un servidor MCP (Supabase, Sentry) vive en un archivo
 * sólo legible por el usuario, fuera de la base: una empresa exportada no se
 * lleva el token. Y se va con el servidor.
 */

let dir: string;
const server = { id: "mcp_abc123", name: "supabase" } as McpServer;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "orq-oauth-")), "mcp-oauth");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("credencial OAuth de un servidor MCP", () => {
  it("guarda cliente y tokens en un archivo 0600 y los recupera en la próxima conexión", () => {
    let pedida: string | null = null;
    const fabrica = crearFabricaOAuth(dir, "http://localhost:3002/api/mcp/oauth/callback");
    const uno = fabrica(server, (url) => (pedida = url.toString()))!;
    expect(uno.clientMetadata.redirect_uris).toEqual(["http://localhost:3002/api/mcp/oauth/callback"]);
    uno.saveClientInformation!({ client_id: "cli_1" });
    uno.saveCodeVerifier("verificador");
    uno.redirectToAuthorization(new URL("https://api.supabase.com/v1/oauth/authorize?state=x"));
    expect(pedida).toContain("oauth/authorize");
    uno.saveTokens({ access_token: "tok", token_type: "bearer", refresh_token: "ref" });

    const archivo = join(dir, "mcp_abc123.json");
    expect(statSync(archivo).mode & 0o777).toBe(0o600);
    // El verificador PKCE es de un solo pedido: con los tokens ya no hace falta.
    expect(JSON.parse(readFileSync(archivo, "utf8")).verificador).toBeUndefined();

    const dos = fabrica(server, () => {})!;
    expect(dos.clientInformation()).toEqual({ client_id: "cli_1" });
    expect(dos.tokens()).toMatchObject({ access_token: "tok", refresh_token: "ref" });
    // El state es único por proveedor: ata la vuelta del navegador a este pedido.
    expect(uno.state!()).not.toBe(dos.state!());
  });

  it("invalidar tokens deja el cliente; olvidar el servidor borra el archivo", () => {
    const fabrica = crearFabricaOAuth(dir, "http://x/cb");
    const p = fabrica(server, () => {})!;
    p.saveClientInformation!({ client_id: "cli_1" });
    p.saveTokens({ access_token: "tok", token_type: "bearer" });
    p.invalidateCredentials!("tokens");
    const otro = fabrica(server, () => {})!;
    expect(otro.tokens()).toBeUndefined();
    expect(otro.clientInformation()).toEqual({ client_id: "cli_1" });
    olvidarOAuth(dir, server.id);
    expect(existsSync(join(dir, "mcp_abc123.json"))).toBe(false);
  });
});
