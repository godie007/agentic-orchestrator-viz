import { describe, expect, it } from "vitest";
import { crearFila, esLimiteDeTasa, esperaDeReintento } from "./bridge.js";

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

/**
 * El límite de tasa del servicio que está detrás del servidor MCP.
 *
 * La fila serializa pero no espacia: dos búsquedas de dos agentes salen una
 * detrás de la otra y, si la primera contesta rápido, las dos caen en el mismo
 * segundo. Con Brave en plan Free —una consulta por segundo— eso es un 429
 * seguro, y lo medimos así: dos llamadas estampadas a las 20:46:33, la primera
 * con resultados y la segunda rechazada.
 */
describe("límite de tasa", () => {
  /** El mensaje tal cual lo devolvió Brave, no una paráfrasis. */
  const MENSAJE_DE_BRAVE =
    'ERROR: mcp__brave__brave_web_search: Error: Brave API error: 429 Too Many Requests ' +
    '{"type":"ErrorResponse","error":{"status":429,"detail":"Request rate limit exceeded for plan",' +
    '"meta":{"plan":"Free","rate_limit":1,"rate_current":1,"quota_limit":2000,"quota_current":27},' +
    '"code":"RATE_LIMITED"}}';

  it("reconoce las tres formas en que un servidor MCP lo dice", () => {
    expect(esLimiteDeTasa(MENSAJE_DE_BRAVE)).toBe(true);
    expect(esLimiteDeTasa("ERROR: rate limit exceeded")).toBe(true);
    expect(esLimiteDeTasa("ERROR: Too Many Requests")).toBe(true);
  });

  it("no confunde otros errores con un límite", () => {
    // Reintentar acá sería demorar la fila del servidor para nada.
    expect(esLimiteDeTasa("ERROR: 404 Not Found")).toBe(false);
    expect(esLimiteDeTasa("ERROR: 500 Internal Server Error")).toBe(false);
    expect(esLimiteDeTasa("ERROR: la búsqueda no devolvió resultados")).toBe(false);
    // Un 4290 no es un 429: la palabra completa, no el prefijo.
    expect(esLimiteDeTasa("ERROR: código 4290")).toBe(false);
  });

  it("espera un poco más de un segundo, que es lo que pide un límite por segundo", () => {
    // 1100 ms y no 1000: con exactamente un segundo el reintento vuelve a caer
    // sobre el borde de la ventana y el límite se dispara de nuevo.
    expect(esperaDeReintento(MENSAJE_DE_BRAVE, 1)).toBeGreaterThan(1_000);
    // El segundo intento espera más que el primero.
    expect(esperaDeReintento(MENSAJE_DE_BRAVE, 2)).toBeGreaterThan(
      esperaDeReintento(MENSAJE_DE_BRAVE, 1),
    );
  });

  it("le hace caso al servicio cuando dice cuánto esperar, y lo acota", () => {
    // Nadie sabe mejor que él cuándo vuelve a atender.
    expect(esperaDeReintento('{"retry-after": 3}', 1)).toBe(3_000);
    expect(esperaDeReintento("Retry-After: 5", 1)).toBe(5_000);
    // Un valor disparatado no puede dejar la fila del servidor congelada.
    expect(esperaDeReintento("retry-after: 86400", 1)).toBe(15_000);
  });
});
