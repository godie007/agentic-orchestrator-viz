import { describe, expect, it } from "vitest";
import { crearFila } from "./bridge.js";

/**
 * La fila de un servidor MCP.
 *
 * Existe por una falla que no da error: dos agentes del mismo ciclo navegando el
 * mismo navegador se pisan la pestaña, y el segundo lee la página del primero
 * creyendo que es la suya. Un dato equivocado con aspecto de correcto es peor
 * que una excepción.
 */
describe("crearFila", () => {
  const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("nunca hay dos tareas adentro al mismo tiempo", async () => {
    const fila = crearFila();
    let adentro = 0;
    let simultaneasMaximas = 0;

    const tarea = async (): Promise<void> => {
      adentro += 1;
      simultaneasMaximas = Math.max(simultaneasMaximas, adentro);
      await dormir(5);
      adentro -= 1;
    };

    await Promise.all([fila(tarea), fila(tarea), fila(tarea), fila(tarea)]);
    expect(simultaneasMaximas).toBe(1);
  });

  it("respeta el orden en que se pidió el turno", async () => {
    const fila = crearFila();
    const orden: number[] = [];
    // La primera tarda más que las que la siguen: sin fila, terminaría última.
    await Promise.all([
      fila(async () => {
        await dormir(20);
        orden.push(1);
      }),
      fila(async () => {
        orden.push(2);
      }),
      fila(async () => {
        orden.push(3);
      }),
    ]);
    expect(orden).toEqual([1, 2, 3]);
  });

  it("una tarea que falla no deja sin turno a las que esperan", async () => {
    // Si la fila se cortara con el primer error, un servidor que devuelve un
    // fallo dejaría colgados a todos los agentes que venían atrás.
    const fila = crearFila();
    const rota = fila(async () => {
      throw new Error("se cayó");
    });
    const siguiente = fila(async () => "llegué");

    await expect(rota).rejects.toThrow("se cayó");
    await expect(siguiente).resolves.toBe("llegué");
  });

  it("devuelve el resultado de cada tarea a quien la pidió", async () => {
    const fila = crearFila();
    const resultados = await Promise.all([
      fila(async () => "a"),
      fila(async () => "b"),
      fila(async () => "c"),
    ]);
    expect(resultados).toEqual(["a", "b", "c"]);
  });

  it("dos servidores distintos no se esperan entre sí", async () => {
    // La fila es por servidor: serializar todo el MCP haría que una llamada
    // lenta a un servidor frenara a los demás sin ninguna razón.
    const unaFila = crearFila();
    const otraFila = crearFila();
    let terminoLaRapida = false;

    const lenta = unaFila(async () => {
      await dormir(30);
    });
    const rapida = otraFila(async () => {
      terminoLaRapida = true;
    });

    await rapida;
    expect(terminoLaRapida).toBe(true);
    await lenta;
  });
});
