/**
 * Chrome como taller de revelado: HTML → cuadros PNG.
 *
 * `video.ts` dibuja con lo que ffmpeg ya trae y ese sigue siendo el camino
 * correcto para maquetar seis placas de texto. Pero una lámina de estudio
 * —tipografía real, SVG que se dibuja solo, tarjetas de vidrio, entradas
 * escalonadas— no se escribe en ASS: se escribe en HTML, que es además el
 * lenguaje que un agente sabe programar. Para eso hace falta un navegador.
 *
 * No se instala ninguno. Se maneja **el Chrome que ya está en la máquina** por
 * su protocolo de depuración (CDP), con el `WebSocket` nativo de Node: cero
 * dependencias nuevas, ningún binario de 150 MB en `node_modules`, y la misma
 * regla que el resto del proyecto —Kokoro, ffmpeg, `say`—: usar lo que hay y
 * degradar con un aviso claro cuando no está.
 *
 * ## El cuadro se calcula, no se graba
 *
 * Grabar la pantalla mientras el reloj corre da un video que depende de lo
 * rápido que sea la máquina: en una lenta, la animación sale a tirones. Acá se
 * **pausan todas las animaciones** y se les fija el tiempo cuadro por cuadro
 * (`Animation.currentTime`), así que el resultado es idéntico en cualquier
 * máquina y a cualquier velocidad de captura. Es el mismo principio que el
 * resto del render: el tiempo es un dato, no algo que se mide con un cronómetro.
 *
 * Sólo se captura **lo que se mueve**. Una lámina entra en dos segundos y
 * después se queda quieta; capturar los quince segundos restantes serían 450
 * PNG idénticos. Se mide cuánto dura la animación, se filma eso y el render
 * sostiene el último cuadro. Por eso el fondo animado lo sigue poniendo ffmpeg
 * por detrás: es lo único que se mueve todo el tiempo, y cuesta cero.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Dónde suele estar Chrome, en orden de preferencia. */
const CANDIDATOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

/**
 * Un navegador que no arranca cuelga el render entero.
 *
 * Es la misma lección que dejó el endpoint de imágenes de NVIDIA: un proceso
 * que acepta y se queda callado no falla, no sigue, y no se le puede pedir al
 * agente que cambie de enfoque. Todo lo que sale de acá lleva corte por tiempo.
 */
const CORTE = { arranque: 20_000, comando: 30_000, carga: 20_000 } as const;

/** El lienzo. Es el mismo que el del video: la lámina se compone a tamaño real. */
export const LIENZO = { ancho: 1920, alto: 1080, fps: 30 } as const;

/** Tope de animación que se filma, en segundos. Más que esto no es una entrada. */
const ANIMACION_MAXIMA = 8;

export function buscarChrome(explicito?: string): string | null {
  const candidatos = [explicito, process.env.ORQ_CHROME, ...CANDIDATOS].filter(
    (ruta): ruta is string => typeof ruta === "string" && ruta !== "",
  );
  return candidatos.find((ruta) => existsSync(ruta)) ?? null;
}

interface Pendiente {
  resolve: (valor: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Cliente mínimo de CDP sobre el `WebSocket` de Node.
 *
 * Se conecta directo al *target* de la pestaña y no al del navegador: así los
 * comandos van sin `sessionId` y no hace falta el baile de `Target.attach`.
 */
class Cdp {
  private siguiente = 1;
  private readonly pendientes = new Map<number, Pendiente>();
  private readonly oyentes = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  private constructor(private readonly ws: WebSocket) {}

  static async conectar(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise<void>((resolve, reject) => {
      const fallo = (): void => reject(new Error(`No se pudo abrir la sesión CDP en ${url}`));
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", fallo, { once: true });
    });

    ws.addEventListener("message", (evento) => {
      const mensaje = JSON.parse(String(evento.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (mensaje.id !== undefined) {
        const pendiente = cdp.pendientes.get(mensaje.id);
        if (!pendiente) return;
        cdp.pendientes.delete(mensaje.id);
        if (mensaje.error) pendiente.reject(new Error(mensaje.error.message));
        else pendiente.resolve(mensaje.result ?? {});
        return;
      }
      if (mensaje.method) {
        for (const oyente of cdp.oyentes.get(mensaje.method) ?? []) {
          oyente(mensaje.params ?? {});
        }
      }
    });

    // Una conexión que se cae con comandos en vuelo dejaría promesas colgadas
    // para siempre: se rechazan todas juntas.
    ws.addEventListener("close", () => {
      for (const [, pendiente] of cdp.pendientes) {
        pendiente.reject(new Error("El navegador cerró la conexión durante el render."));
      }
      cdp.pendientes.clear();
    });

    return cdp;
  }

  enviar(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.siguiente++;
    const promesa = new Promise<Record<string, unknown>>((resolve, reject) => {
      const reloj = setTimeout(() => {
        this.pendientes.delete(id);
        reject(new Error(`El navegador no contestó a ${method}.`));
      }, CORTE.comando);
      this.pendientes.set(id, {
        resolve: (valor) => {
          clearTimeout(reloj);
          resolve(valor);
        },
        reject: (error) => {
          clearTimeout(reloj);
          reject(error);
        },
      });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promesa;
  }

  al(method: string, oyente: (params: Record<string, unknown>) => void): void {
    const lista = this.oyentes.get(method) ?? [];
    lista.push(oyente);
    this.oyentes.set(method, lista);
  }

  cerrar(): void {
    this.ws.close();
  }
}

/** Lo que devuelve filmar una lámina. */
export interface Captura {
  /** Rutas de los PNG, en orden. Siempre hay al menos uno. */
  cuadros: string[];
  /** Cuánto dura la animación filmada, en segundos. */
  animacion: number;
  /** Lo que salió mal y el agente puede corregir: CSS que no cargó, un error. */
  avisos: string[];
}

export interface OpcionesRevelado {
  chrome?: string;
  /**
   * Color de fondo, en hexadecimal. Sin esto la lámina sale **transparente**.
   *
   * Transparente es lo correcto para filmar —el fondo lo genera ffmpeg y se
   * mueve por detrás—, pero es lo peor para mirar un PNG suelto: el visor lo
   * compone sobre blanco y un texto claro desaparece. Una lámina perfecta se
   * veía rota, que es la peor devolución posible para quien la programó.
   */
  fondo?: string;
  /** Corta el render si la corrida se detiene. */
  signal?: AbortSignal;
}

/** `#0a0e1a` → los canales que espera CDP. Sin color, transparente. */
function canales(hex?: string): { r: number; g: number; b: number; a: number } {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
    a: 1,
  };
}

/**
 * El navegador abierto, listo para revelar láminas.
 *
 * Es **uno solo para todo el video**: arrancar Chrome cuesta un par de
 * segundos, y hacerlo por lámina multiplicaba ese costo por cada escena.
 */
export interface Revelado {
  /**
   * Filma una lámina y devuelve sus cuadros.
   *
   * @param url      `file://` de la lámina.
   * @param destino  Carpeta donde dejar los PNG.
   * @param prefijo  Nombre base de los cuadros; ffmpeg los lee como secuencia.
   */
  revelar(url: string, destino: string, prefijo: string): Promise<Captura>;
  cerrar(): Promise<void>;
}

/** Prepara la página: pausa todo lo que se mueve y expone cómo adelantarlo. */
const GUION_DE_SALA = `
  (() => {
    const animaciones = document.getAnimations();
    for (const a of animaciones) { try { a.pause(); } catch {} }
    window.__orqAnimaciones = animaciones;
    window.__orqIr = (segundos) => {
      for (const a of window.__orqAnimaciones) {
        try { a.currentTime = segundos * 1000; } catch {}
      }
    };
    let fin = 0;
    for (const a of animaciones) {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      const e = t ? t.endTime : 0;
      if (typeof e === "number" && Number.isFinite(e)) fin = Math.max(fin, e / 1000);
    }
    return {
      animacion: fin,
      infinitas: animaciones.filter((a) => {
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        return t ? !Number.isFinite(t.endTime) : false;
      }).length,
      ancho: document.documentElement.scrollWidth,
      alto: document.documentElement.scrollHeight,
    };
  })()
`;

export async function abrirRevelado(opciones: OpcionesRevelado = {}): Promise<Revelado> {
  const binario = buscarChrome(opciones.chrome);
  if (!binario) {
    throw new Error(
      "No se encontró Google Chrome en esta máquina. La habilidad de estudio revela las " +
        "láminas con el navegador ya instalado; instalá Chrome o poné su ruta en ORQ_CHROME.",
    );
  }

  const perfil = await mkdtemp(join(tmpdir(), "orq-chrome-"));
  const proceso = spawn(
    binario,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${perfil}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      // El texto se compone sobre transparencia y se mezcla después con el
      // fondo de ffmpeg: con subpíxeles activados los bordes salen con franjas
      // de color en los cuadros con alfa.
      "--disable-lcd-text",
      "--font-render-hinting=none",
      // Las láminas viven en el directorio de la empresa y traen su hoja de
      // estilo y sus fotos de carpetas hermanas por ruta relativa.
      "--allow-file-access-from-files",
      `--window-size=${LIENZO.ancho},${LIENZO.alto}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const limpiar = async (): Promise<void> => {
    proceso.kill("SIGTERM");
    await rm(perfil, { recursive: true, force: true });
  };

  let puerto: number;
  try {
    puerto = await esperarPuerto(proceso);
  } catch (error) {
    await limpiar();
    throw error;
  }

  let cdp: Cdp;
  try {
    cdp = await Cdp.conectar(await buscarPestaña(puerto));
    await cdp.enviar("Page.enable");
    await cdp.enviar("Runtime.enable");
    await cdp.enviar("Log.enable");
    await cdp.enviar("Emulation.setDeviceMetricsOverride", {
      width: LIENZO.ancho,
      height: LIENZO.alto,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Por defecto, fondo transparente: la lámina se compone **encima** del
    // degradado que genera ffmpeg, que es lo único que se mueve durante toda la
    // escena. Una lámina que quiera su propio fondo lo pinta y tapa el de abajo.
    // Quien previsualiza pide un color: ver el PNG suelto sobre blanco no
    // muestra lo que se va a filmar.
    await cdp.enviar("Emulation.setDefaultBackgroundColorOverride", {
      color: canales(opciones.fondo),
    });
  } catch (error) {
    await limpiar();
    throw error;
  }

  const avisosDeCarga: string[] = [];
  cdp.al("Log.entryAdded", (params) => {
    const entrada = params.entry as { level?: string; text?: string } | undefined;
    if (entrada?.level === "error" && entrada.text) avisosDeCarga.push(entrada.text);
  });
  cdp.al("Runtime.exceptionThrown", (params) => {
    const detalle = params.exceptionDetails as { text?: string } | undefined;
    if (detalle?.text) avisosDeCarga.push(detalle.text);
  });

  return {
    async revelar(url, destino, prefijo) {
      opciones.signal?.throwIfAborted();
      avisosDeCarga.length = 0;

      const cargada = new Promise<void>((resolve) => {
        const listo = (): void => resolve();
        cdp.al("Page.loadEventFired", listo);
        setTimeout(listo, CORTE.carga);
      });
      await cdp.enviar("Page.navigate", { url });
      await cargada;

      // Sin esperar a las fuentes, el primer cuadro sale con la tipografía de
      // respaldo y el texto salta de familia a mitad de la entrada.
      await cdp
        .enviar("Runtime.evaluate", {
          expression: "document.fonts.ready.then(() => true)",
          awaitPromise: true,
        })
        .catch(() => undefined);

      const sala = (await cdp.enviar("Runtime.evaluate", {
        expression: GUION_DE_SALA,
        returnByValue: true,
      })) as { result?: { value?: Record<string, number> } };
      const medida = sala.result?.value ?? {};

      const avisos: string[] = [];
      const ancho = medida.ancho ?? LIENZO.ancho;
      const alto = medida.alto ?? LIENZO.alto;
      if (ancho > LIENZO.ancho + 2 || alto > LIENZO.alto + 2) {
        avisos.push(
          `La lámina ${prefijo} se desborda del cuadro (${ancho}×${alto} sobre ` +
            `${LIENZO.ancho}×${LIENZO.alto}): lo que sobra no se ve. Sacá contenido o bajá el cuerpo.`,
        );
      }
      if ((medida.infinitas ?? 0) > 0) {
        avisos.push(
          `La lámina ${prefijo} tiene animaciones en bucle infinito: se filma sólo la entrada ` +
            `y después queda quieta. El movimiento continuo lo pone el fondo.`,
        );
      }

      const animacion = Math.min(medida.animacion ?? 0, ANIMACION_MAXIMA);
      const cuadros = Math.max(1, Math.ceil(animacion * LIENZO.fps));
      const rutas: string[] = [];
      for (let i = 0; i < cuadros; i++) {
        opciones.signal?.throwIfAborted();
        const t = cuadros === 1 ? animacion : (i / LIENZO.fps);
        await cdp.enviar("Runtime.evaluate", {
          expression: `window.__orqIr(${t.toFixed(4)})`,
        });
        const disparo = (await cdp.enviar("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        })) as { data?: string };
        const ruta = join(destino, `${prefijo}-${String(i).padStart(4, "0")}.png`);
        await writeFile(ruta, Buffer.from(disparo.data ?? "", "base64"));
        rutas.push(ruta);
      }

      // Un `.css` que no cargó es la falla más común y la más silenciosa: la
      // lámina sale con la tipografía del sistema y nadie se entera hasta ver
      // el video. Vuelve como aviso, que es lo único que el agente puede leer.
      for (const error of avisosDeCarga.slice(0, 3)) {
        avisos.push(`En ${prefijo}: ${error.split("\n")[0]}`);
      }

      return { cuadros: rutas, animacion, avisos };
    },

    async cerrar() {
      cdp.cerrar();
      await limpiar();
    },
  };
}

/** Chrome anuncia su puerto en stderr; no hay forma de pedírselo antes. */
function esperarPuerto(proceso: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let acumulado = "";
    const reloj = setTimeout(() => {
      reject(new Error("Chrome no anunció su puerto de depuración a tiempo."));
    }, CORTE.arranque);

    proceso.stderr?.on("data", (trozo: Buffer) => {
      acumulado += trozo.toString();
      const encontrado = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(acumulado);
      if (encontrado) {
        clearTimeout(reloj);
        resolve(Number(encontrado[1]));
      }
    });
    proceso.on("error", (error) => {
      clearTimeout(reloj);
      reject(new Error(`No se pudo ejecutar Chrome: ${error.message}`));
    });
    proceso.on("exit", (code) => {
      clearTimeout(reloj);
      reject(new Error(`Chrome terminó con código ${String(code)} antes de abrir la sesión.`));
    });
  });
}

/** La pestaña que abrió Chrome al arrancar. Puede tardar un instante en listarse. */
async function buscarPestaña(puerto: number): Promise<string> {
  for (let intento = 0; intento < 40; intento++) {
    try {
      const respuesta = await fetch(`http://127.0.0.1:${puerto}/json/list`);
      const pestañas = (await respuesta.json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const pagina = pestañas.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
      if (pagina?.webSocketDebuggerUrl) return pagina.webSocketDebuggerUrl;
    } catch {
      // Todavía no levantó el servidor de depuración.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome levantó, pero no expuso ninguna pestaña para revelar las láminas.");
}
