import { describe, expect, it } from "vitest";
import { normalizarNombre, parsearConfigMcp, referenciaDe } from "./mcp-config.js";

describe("referenciaDe", () => {
  it("toma un nombre de variable como referencia", () => {
    expect(referenciaDe("GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(referenciaDe("${GITHUB_TOKEN}")).toBe("GITHUB_TOKEN");
    expect(referenciaDe("$GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
  });

  it("un secreto de verdad no es una referencia", () => {
    // Ante la duda gana no guardar: un falso negativo cuesta escribir el nombre
    // a mano, un falso positivo escribe una credencial en la base.
    expect(referenciaDe("ghp_A1b2C3d4E5f6")).toBeNull();
    expect(referenciaDe("sk-proj-abc123")).toBeNull();
    expect(referenciaDe("/Users/ana/vault")).toBeNull();
  });
});

describe("normalizarNombre", () => {
  it("deja un nombre usable como segmento de mcp__<servidor>__<tool>", () => {
    expect(normalizarNombre("Browser MCP")).toBe("browser-mcp");
    expect(normalizarNombre("memoria")).toBe("memoria");
    expect(normalizarNombre("Notión")).toBe("notion");
  });
});

describe("parsearConfigMcp", () => {
  it("importa el bloque estándar que publican los servidores", () => {
    const { servidores, avisos } = parsearConfigMcp(
      JSON.stringify({
        mcpServers: { browsermcp: { command: "npx", args: ["@browsermcp/mcp@latest"] } },
      }),
    );
    expect(avisos).toEqual([]);
    expect(servidores).toHaveLength(1);
    expect(servidores[0]).toMatchObject({
      name: "browsermcp",
      transport: { type: "stdio", command: "npx", args: ["@browsermcp/mcp@latest"] },
    });
  });

  it("acepta también el mapa a secas, sin la envoltura mcpServers", () => {
    const { servidores } = parsearConfigMcp(
      JSON.stringify({ memoria: { command: "node", args: ["server.js"] } }),
    );
    expect(servidores.map((s) => s.name)).toEqual(["memoria"]);
  });

  it("una variable escrita por nombre entra como referencia", () => {
    const { servidores, avisos } = parsearConfigMcp(
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "GITHUB_TOKEN" } } },
      }),
    );
    expect(avisos).toEqual([]);
    expect(servidores[0]!.transport).toMatchObject({
      envRefs: { GITHUB_TOKEN: "GITHUB_TOKEN" },
    });
  });

  it("un secreto literal NO se guarda, y se avisa por qué", () => {
    // Es la garantía documentada: una empresa exportada a JSON no puede llevar
    // credenciales adentro. Descartarlo en silencio sería peor que no importar.
    const { servidores, avisos } = parsearConfigMcp(
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secreto123" } } },
      }),
    );
    expect(JSON.stringify(servidores)).not.toContain("ghp_secreto123");
    expect(servidores[0]!.transport).toMatchObject({ envRefs: {} });
    expect(avisos.join(" ")).toContain("por referencia");
  });

  it("un servidor http entra por url y sus headers también son referencias", () => {
    const { servidores } = parsearConfigMcp(
      JSON.stringify({
        mcpServers: { remoto: { url: "https://ejemplo.com/mcp", headers: { Authorization: "TOKEN_X" } } },
      }),
    );
    expect(servidores[0]!.transport).toMatchObject({
      type: "http",
      url: "https://ejemplo.com/mcp",
      headerRefs: { Authorization: "TOKEN_X" },
    });
  });

  it("avisa cuando no sabe cómo conectar un servidor", () => {
    const { servidores, avisos } = parsearConfigMcp(
      JSON.stringify({ mcpServers: { raro: { foo: "bar" } } }),
    );
    expect(servidores).toEqual([]);
    expect(avisos.join(" ")).toContain("no se sabe cómo conectarlo");
  });

  it("un JSON inválido vuelve como aviso y no como excepción", () => {
    const { servidores, avisos } = parsearConfigMcp("{ esto no es json");
    expect(servidores).toEqual([]);
    expect(avisos[0]).toContain("No es JSON válido");
  });

  it("renombra lo que no sirve como identificador y lo dice", () => {
    const { servidores, avisos } = parsearConfigMcp(
      JSON.stringify({ mcpServers: { "Mi Servidor": { command: "x" } } }),
    );
    expect(servidores[0]!.name).toBe("mi-servidor");
    expect(avisos.join(" ")).toContain("mi-servidor");
  });
});
