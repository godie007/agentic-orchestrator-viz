import { describe, expect, it } from "vitest";
import { decidirComando, empiezaCon, tokenizar, validarPrefijoPermitido } from "./argv.js";

/**
 * La allowlist de comandos se decide token por token y sin shell.
 *
 * Guardada como texto y comparada por prefijo, `npm test` habilitaba
 * `npm testx` y `npm test; rm -rf ~`. Estos casos fijan que eso no vuelve.
 */

describe("tokenizar", () => {
  it("respeta comillas y no expande nada", () => {
    expect(tokenizar(`pytest -k "suma y resta" tests/`)).toEqual({
      ok: true,
      argv: ["pytest", "-k", "suma y resta", "tests/"],
    });
  });

  it("rechaza sintaxis de shell y explica por qué", () => {
    for (const comando of ["npm test && rm -rf ~", "npm test; ls", "cat a | grep b", "echo $(whoami)", "ls > x", "ls *"]) {
      const resultado = tokenizar(comando);
      expect(resultado.ok, comando).toBe(false);
    }
  });

  it("una comilla sin cerrar es un error, no un argumento raro", () => {
    expect(tokenizar(`npm run "build`).ok).toBe(false);
  });
});

describe("empiezaCon", () => {
  it("compara por token: npm test no habilita npm testx", () => {
    expect(empiezaCon(["npm", "test"], ["npm", "test"])).toBe(true);
    expect(empiezaCon(["npm", "test", "--", "-t", "x"], ["npm", "test"])).toBe(true);
    expect(empiezaCon(["npm", "testx"], ["npm", "test"])).toBe(false);
  });
});

describe("validarPrefijoPermitido", () => {
  it("no acepta prefijos que lo permiten todo", () => {
    for (const prefijo of [["npx"], ["node"], ["bash"], ["sh", "-c"], ["npm"], ["npm", "run"], ["git"], ["python", "-c"], ["rm", "-rf"]]) {
      expect(validarPrefijoPermitido(prefijo).ok, prefijo.join(" ")).toBe(false);
    }
  });

  it("acepta los que dicen qué corren", () => {
    for (const prefijo of [["npm", "test"], ["npm", "run", "typecheck"], ["pytest"], ["go", "test"], ["node", "scripts/check.js"]]) {
      expect(validarPrefijoPermitido(prefijo).ok, prefijo.join(" ")).toBe(true);
    }
  });

  it("no deja permitir publicar ni tocar credenciales", () => {
    expect(validarPrefijoPermitido(["npm", "publish"]).ok).toBe(false);
    expect(validarPrefijoPermitido(["git", "push"]).ok).toBe(false);
  });
});

describe("decidirComando", () => {
  const comandos = { permitidos: [["npm", "test"]], unaVez: [["npm", "run", "e2e"]] };

  it("la allowlist permite por prefijo; el permiso de una vez, sólo el argv exacto", () => {
    expect(decidirComando(["npm", "test", "--", "-t", "suma"], comandos)).toEqual({ permitido: true, motivo: "allowlist" });
    expect(decidirComando(["npm", "run", "e2e"], comandos)).toEqual({ permitido: true, motivo: "una-vez" });
    expect(decidirComando(["npm", "run", "e2e", "--headed"], comandos).permitido).toBe(false);
  });

  it("leer git se permite siempre; escribir o ejecutar desde git, nunca", () => {
    expect(decidirComando(["git", "status"], comandos).permitido).toBe(true);
    expect(decidirComando(["git", "diff", "--output=/tmp/x"], comandos).permitido).toBe(false);
    expect(decidirComando(["git", "push", "origin"], { permitidos: [["git", "push"]], unaVez: [] }).permitido).toBe(false);
  });

  it("lo que no está permitido dice cómo pedirlo", () => {
    const decision = decidirComando(["make", "deploy"], comandos);
    expect(decision.permitido).toBe(false);
    expect(decision.permitido === false && decision.motivo).toContain("solicitar_comando");
  });
});
