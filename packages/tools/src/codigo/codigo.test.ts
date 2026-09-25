import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ComandosRepositorio } from "@orq/shared";
import type { RegisteredTool, ToolContext } from "../types.js";
import { crearHerramientasDeCodigo } from "./index.js";
import { ejecutarComando, entornoDeComando, hayAislamiento } from "./ejecutar.js";
import { extraerSimbolos, mapaDelCodigo, olvidarIndice } from "./indice.js";
import { globARegex } from "./glob.js";
import { resolverEnWorktree } from "./rutas.js";
import type { CodigoStorage, EspacioDeCodigo } from "./tipos.js";

/**
 * Las herramientas de código sobre un repo de verdad.
 *
 * Lo que se fija acá son las reglas que viven en el ejecutor y no en el
 * prompt: nada se escribe fuera del árbol ni adentro de `.git`, una edición
 * ambigua no se aplica, un bloque parecido salvo espacios se informa y no se
 * aplica solo, sin arriendo no se escribe, y un test que falla es un resultado
 * y no un error de la herramienta —si lo fuera, el freno de llamadas idénticas
 * cortaría el ciclo corregir → testear a la tercera vuelta—.
 */

let dir: string;
let escribe: boolean;
let comandos: ComandosRepositorio;
let tools: Map<string, RegisteredTool>;

const ctx = { runId: "run1", tick: 1, actor: { id: "rol1", name: "Tomás" }, workspace: {} } as unknown as ToolContext;

function sh(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: dir, encoding: "utf8" });
}

function storage(): CodigoStorage {
  const espacio = (): EspacioDeCodigo => ({
    repoId: "rep1",
    nombre: "app",
    dir,
    rama: "orq/test",
    baseSha: sh("rev-parse", "HEAD").trim(),
    ramaBase: "main",
    comandos,
    pendienteDeConfirmar: false,
  });
  const base = espacio().baseSha;
  return {
    listar: async () => [],
    espacio: async () => ({ ok: true, espacio: { ...espacio(), baseSha: base } }),
    puedeEscribir: () => (escribe ? { ok: true } : { ok: false, motivo: "escribe otro rol" }),
    git: (_e, args, opciones) =>
      new Promise((resolve) => {
        const hijo = execFile("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: dir, encoding: "utf8" }, (error, stdout, stderr) => {
          const codigo = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ ok: codigo === 0, codigo, stdout, stderr });
        });
        if (opciones?.entrada != null) hijo.stdin?.end(opciones.entrada);
      }),
    ejecutar: (e, argv, opciones) =>
      ejecutarComando({
        argv,
        cwd: opciones.carpeta ? join(e.dir, opciones.carpeta) : e.dir,
        tmpDir: join(dir, "..", "tmp"),
        corteMs: opciones.corteMs,
        aislamiento: { tipo: "ninguno" },
      }),
    consumirUnaVez: async () => {},
    crear: async () => ({ ok: false, motivo: "no en este test" }),
    servicios: async () => [],
    logsDeServicio: async () => ({ ok: false, motivo: "no en este test" }),
    probarServicio: async () => ({ ok: false, motivo: "no en este test" }),
  };
}

async function correr(nombre: string, args: Record<string, unknown>) {
  const tool = tools.get(nombre);
  if (!tool) throw new Error(`no existe ${nombre}`);
  return tool.execute(args, ctx);
}

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orq-codigo-")));
  dir = join(base, "repo");
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "src", "suma.ts"),
    "export function suma(a: number, b: number) {\n  return a + b;\n}\n\nexport function resta(a: number, b: number) {\n  return a - b;\n}\n",
  );
  writeFileSync(join(dir, "src", "uso.ts"), 'import { suma } from "./suma";\nexport const total = suma(1, 2);\n');
  writeFileSync(join(dir, "config.py"), "def cargar():\n    valor = 1\n    return valor\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "base");
  escribe = true;
  comandos = { permitidos: [["node"]], preparar: null, test: null, verificar: null, sinAislamiento: true, unaVez: [] };
  tools = new Map(crearHerramientasDeCodigo(storage()).map((t) => [t.name, t]));
  olvidarIndice();
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("resolverEnWorktree", () => {
  it("no deja salir del árbol, ni entrar a .git, ni escapar por un symlink", async () => {
    expect((await resolverEnWorktree(dir, "../fuera.txt")).ok).toBe(false);
    expect((await resolverEnWorktree(dir, "/etc/passwd")).ok).toBe(false);
    expect((await resolverEnWorktree(dir, ".git/hooks/pre-commit")).ok).toBe(false);
    expect((await resolverEnWorktree(dir, "src/../.git/config")).ok).toBe(false);
    symlinkSync(tmpdir(), join(dir, "afuera"));
    expect((await resolverEnWorktree(dir, "afuera/robado.txt")).ok).toBe(false);
  });

  it("respeta los nombres de código que el saneo de entregables rompía", async () => {
    const r = await resolverEnWorktree(dir, "app/[id]/.eslintrc.json");
    expect(r.ok && r.relativa).toBe("app/[id]/.eslintrc.json");
  });
});

describe("leer_codigo", () => {
  it("numera las líneas y dice cómo seguir", async () => {
    const r = await correr("leer_codigo", { ruta: "src/suma.ts", limite: 2 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1→export function suma");
    expect(r.content).toContain("2→  return a + b;");
    expect(r.content).toContain("desde=3");
  });

  it("rechaza binarios", async () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 0]));
    expect((await correr("leer_codigo", { ruta: "img.bin" })).ok).toBe(false);
  });
});

describe("editar_codigo", () => {
  it("reemplaza un texto exacto y único, y devuelve cómo quedó", async () => {
    const r = await correr("editar_codigo", { ruta: "src/suma.ts", buscar: "return a + b;", reemplazar: "return b + a;" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "src/suma.ts"), "utf8")).toContain("return b + a;");
    expect(r.content).toContain("→  return b + a;");
  });

  it("si aparece varias veces no adivina: nombra las líneas", async () => {
    const r = await correr("editar_codigo", { ruta: "src/suma.ts", buscar: "(a: number, b: number)", reemplazar: "(x: number, y: number)" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("2 veces");
    expect(r.content).toContain("líneas 1, 5");
  });

  it("un bloque igual salvo indentación se informa y NO se aplica", async () => {
    const r = await correr("editar_codigo", { ruta: "config.py", buscar: "valor = 1\nreturn valor", reemplazar: "return 2" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("línea 2");
    expect(readFileSync(join(dir, "config.py"), "utf8")).toBe("def cargar():\n    valor = 1\n    return valor\n");
  });

  it("conserva los finales de línea CRLF del archivo", async () => {
    writeFileSync(join(dir, "win.txt"), "uno\r\ndos\r\ntres\r\n");
    const r = await correr("editar_codigo", { ruta: "win.txt", buscar: "uno\ndos", reemplazar: "1\n2" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "win.txt"), "utf8")).toBe("1\r\n2\r\ntres\r\n");
  });

  it("sin el arriendo de escritura no toca nada", async () => {
    escribe = false;
    const r = await correr("editar_codigo", { ruta: "src/suma.ts", buscar: "return a + b;", reemplazar: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("escribe otro rol");
    expect(readFileSync(join(dir, "src/suma.ts"), "utf8")).toContain("return a + b;");
  });
});

describe("aplicar_parche", () => {
  it("un parche que toca .git no se aplica", async () => {
    const parche = "--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-x\n+y\n";
    const r = await correr("aplicar_parche", { parche });
    expect(r.ok).toBe(false);
  });

  it("aplica un diff de varios archivos entero, o nada", async () => {
    const parche = [
      "--- a/src/suma.ts",
      "+++ b/src/suma.ts",
      "@@ -1,3 +1,3 @@",
      " export function suma(a: number, b: number) {",
      "-  return a + b;",
      "+  return (a + b) | 0;",
      " }",
      "",
    ].join("\n");
    const r = await correr("aplicar_parche", { parche });
    expect(r.ok, r.content).toBe(true);
    expect(readFileSync(join(dir, "src/suma.ts"), "utf8")).toContain("(a + b) | 0");
  });
});

describe("búsqueda y mapa", () => {
  it("buscar_codigo encuentra también en archivos nuevos que no entraron a un commit", async () => {
    writeFileSync(join(dir, "src", "nuevo.ts"), "export const marcaUnica = 1;\n");
    const r = await correr("buscar_codigo", { patron: "marcaUnica" });
    expect(r.content).toContain("src/nuevo.ts:1:");
  });

  it("buscar_archivos entiende ** y * sin cruzar carpetas", async () => {
    expect(globARegex("*.ts").test("src/suma.ts")).toBe(true);
    expect(globARegex("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globARegex("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    const r = await correr("buscar_archivos", { patron: "*.py" });
    expect(r.content).toContain("config.py");
  });

  it("extrae definiciones por lenguaje", () => {
    expect(extraerSimbolos("a.ts", "export class Foo {}\nexport const bar = async (x) => x;\ntype Baz = 1;").map((s) => s.nombre)).toEqual([
      "Foo",
      "bar",
      "Baz",
    ]);
    expect(extraerSimbolos("a.py", "class A:\n    def m(self):\n        pass\ndef f():\n    pass").map((s) => `${s.tipo}:${s.nombre}`)).toEqual([
      "clase:A",
      "método:m",
      "función:f",
    ]);
  });

  it("el mapa pone arriba lo que más se usa, entra en su presupuesto y es determinista", async () => {
    const archivos = ["config.py", "src/suma.ts", "src/uso.ts"];
    const uno = await mapaDelCodigo(dir, archivos, { presupuesto: 2_000 });
    const dos = await mapaDelCodigo(dir, archivos, { presupuesto: 2_000 });
    expect(uno).toBe(dos);
    expect(uno.length).toBeLessThanOrEqual(2_000);
    expect(uno.indexOf("src/suma.ts")).toBeLessThan(uno.indexOf("config.py"));
    expect(uno).toContain("ƒ suma:1");
  });
});

describe("ejecutar_comando", () => {
  it("rechaza sintaxis de shell y lo que no está permitido", async () => {
    expect((await correr("ejecutar_comando", { comando: "node -e 1 && rm -rf /" })).ok).toBe(false);
    const r = await correr("ejecutar_comando", { comando: "make deploy" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("solicitar_comando");
  });

  it("un exit distinto de 0 es un resultado, no un error: el ciclo testear → corregir no se frena", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await correr("ejecutar_comando", { comando: `node -e "console.log('falla');process.exit(1)"` });
      expect(r.ok).toBe(true);
      expect(r.content).toContain("exit 1");
      expect(r.content).toContain("falla");
    }
  });

  it("el comando no ve las credenciales del servidor y corre con CI=1", () => {
    const env = entornoDeComando(
      { PATH: "/usr/bin", HOME: "/h", OPENROUTER_API_KEY: "x", GITHUB_TOKEN: "y", ORQ_CLAUDE_CODE: "1", DB_PASSWORD: "z" },
      "/tmp/p",
    );
    expect(env["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["ORQ_CLAUDE_CODE"]).toBeUndefined();
    expect(env["DB_PASSWORD"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["CI"]).toBe("1");
    expect(env["TMPDIR"]).toBe("/tmp/p");
  });

  it("al vencer el corte mata el grupo entero, nietos incluidos", async () => {
    const marca = join(dir, "..", "nieto-vivo");
    const script = `const {spawn}=require('child_process');spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('${marca}','x'),1500)"],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const r = await ejecutarComando({
      argv: [process.execPath, "-e", script],
      cwd: dir,
      tmpDir: join(dir, "..", "tmp"),
      corteMs: 400,
      aislamiento: { tipo: "ninguno" },
    });
    expect(r.cortadoPorTiempo).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(existsSync(marca)).toBe(false);
  });

  it.skipIf(!hayAislamiento())("en el sandbox no se escribe fuera del worktree ni en .git", async () => {
    // Afuera de verdad: el temporal del sistema está permitido a propósito
    // (compiladores y cachés escriben ahí), así que la prueba apunta al hogar.
    const fuera = join(homedir(), `.orq-sandbox-prueba-${process.pid}`);
    const sandbox = { tipo: "sandbox" as const, escribibles: [dir], noEscribibles: [join(dir, ".git")] };
    const afuera = await ejecutarComando({
      argv: [process.execPath, "-e", `require('fs').writeFileSync('${fuera}','x')`],
      cwd: dir,
      tmpDir: join(dir, "..", "tmp"),
      corteMs: 10_000,
      aislamiento: sandbox,
    });
    const escapo = existsSync(fuera);
    rmSync(fuera, { force: true });
    expect(afuera.codigo).not.toBe(0);
    expect(escapo).toBe(false);

    const hook = await ejecutarComando({
      argv: [process.execPath, "-e", `require('fs').writeFileSync('${join(dir, ".git", "hooks", "pre-commit")}','x')`],
      cwd: dir,
      tmpDir: join(dir, "..", "tmp"),
      corteMs: 10_000,
      aislamiento: sandbox,
    });
    expect(hook.codigo).not.toBe(0);

    const adentro = await ejecutarComando({
      argv: [process.execPath, "-e", `require('fs').writeFileSync('${join(dir, "ok.txt")}','x')`],
      cwd: dir,
      tmpDir: join(dir, "..", "tmp"),
      corteMs: 10_000,
      aislamiento: sandbox,
    });
    expect(adentro.codigo, adentro.salida).toBe(0);
  });
});

describe("instalar_dependencia", () => {
  it("abre una solicitud con el gestor del repo, y valida antes de molestar a nadie", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const creadas: unknown[] = [];
    const conWorkspace = {
      ...ctx,
      workspace: {
        listRequests: () => [],
        createRequest: async (input: unknown) => {
          creadas.push(input);
          return { id: "req_1" };
        },
      },
    } as unknown as ToolContext;
    const tool = tools.get("instalar_dependencia")!;

    const mal = await tool.execute({ paquetes: ["https://evil.example/x.tgz"], motivo: "x" }, conWorkspace);
    expect(mal.ok).toBe(false);
    expect(creadas).toHaveLength(0);

    const bien = await tool.execute({ paquetes: ["three@0.160.0"], motivo: "La escena 3D importa Three.js" }, conWorkspace);
    expect(bien.ok).toBe(true);
    expect(bien.content).toContain("--ignore-scripts");
    expect(creadas[0]).toMatchObject({
      type: "dependencia",
      dependencia: { repoId: "rep1", gestor: "npm", paquetes: ["three@0.160.0"], dev: false },
    });
  });

  it("sin package.json no hay dónde anotar la dependencia", async () => {
    const r = await tools.get("instalar_dependencia")!.execute({ paquetes: ["three"], motivo: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("package.json");
  });
});
