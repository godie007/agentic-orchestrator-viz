import { describe, expect, it } from "vitest";
import { argvDeInstalacion, gestorPorArchivos, validarPaquete } from "./dependencias.js";

/**
 * Qué se puede instalar con un click de aprobación: paquetes del registro por
 * nombre, y siempre sin scripts de instalación.
 */
describe("validarPaquete", () => {
  it("acepta nombres del registro, con scope y con versión", () => {
    for (const p of ["three", "three@0.160.0", "@types/three@^0.160", "lodash@latest", "vitest@>=1 <3"]) {
      expect(validarPaquete(p).ok, p).toBe(true);
    }
  });

  it("rechaza lo que no es un paquete del registro: URLs, git, file:, rutas", () => {
    for (const p of [
      "https://evil.example/pkg.tgz",
      "git+ssh://git@github.com/a/b.git",
      "github:a/b",
      "file:../algo",
      "../algo",
      "/tmp/pkg",
      "Three",
      "",
    ]) {
      expect(validarPaquete(p).ok, p).toBe(false);
    }
  });
});

describe("argvDeInstalacion", () => {
  it("instala siempre sin scripts, con el gestor del repo", () => {
    expect(argvDeInstalacion("npm", ["three@0.160.0"])).toEqual([
      "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save", "three@0.160.0",
    ]);
    expect(argvDeInstalacion("pnpm", ["vitest"], { dev: true })).toEqual(["pnpm", "add", "--ignore-scripts", "-D", "vitest"]);
    expect(argvDeInstalacion("yarn", ["three"])).toContain("--ignore-scripts");
  });

  it("elige el gestor por el lockfile", () => {
    expect(gestorPorArchivos(["package.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(gestorPorArchivos(["package.json", "yarn.lock"])).toBe("yarn");
    expect(gestorPorArchivos(["package.json"])).toBe("npm");
  });
});
