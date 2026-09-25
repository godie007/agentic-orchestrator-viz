import { configDefaults, defineConfig } from "vitest/config";

// `data/` guarda los repos que cargan los proyectos y los worktrees donde
// trabajan los agentes: sus tests son de ellos, no del orquestador, y vitest
// los levantaba como propios.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "data/**", "**/dist/**"],
    // Entre ciclos fallidos el scheduler espera 30 s, 60 s…: en los tests eso
    // serían minutos esperando a un proveedor falso que nunca va a volver.
    env: { ORQ_ESPERA_PROVEEDOR_MS: "0" },
  },
});
