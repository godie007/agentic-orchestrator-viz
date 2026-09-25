import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Dos gits sobre el mismo worktree se cruzan: el `status` del IDE cada tres
 * segundos y el checkpoint de un turno. Un lock que se suelta enseguida no
 * puede hacer fallar el commit —lo pagamos con un cambio de agente que quedó
 * sin commitear—, y uno que no se suelta sí tiene que ser un error.
 */

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orq-git-"));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "hola\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("git con el lock ocupado", () => {
  it("espera a que se suelte y commitea", async () => {
    writeFileSync(join(dir, ".git", "index.lock"), "");
    setTimeout(() => rmSync(join(dir, ".git", "index.lock"), { force: true }), 300);
    await git(["add", "-A"], { cwd: dir });
    const r = await git(["commit", "-q", "-m", "x"], { cwd: dir });
    expect(r.ok).toBe(true);
  });

  it("un lock que no se suelta es un error, no una espera eterna", async () => {
    writeFileSync(join(dir, ".git", "index.lock"), "");
    await expect(git(["add", "-A"], { cwd: dir })).rejects.toThrow(/index\.lock/);
  }, 15_000);
});
