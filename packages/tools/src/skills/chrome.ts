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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mata a Chrome **con todos sus hijos** y limpia el perfil temporal.
 *
 * `--headless=new` es un árbol de procesos: el SIGTERM al lanzador solo dejaba
 * a los ayudantes vivos cuando un turno se abortaba a mitad de captura —
 * medimos seis huérfanos tras una tarde de corridas, comiéndose la memoria que
 * después faltaba para cargar las páginas—. Por eso el spawn va `detached`
 * (grupo de procesos propio) y acá se firma la partida del grupo entero, con
 * SIGKILL de respaldo por si alguno ignora el aviso.
 */
function crearLimpieza(
  proceso: ChildProcess,
  perfil: string,
  /** `false` cuando el perfil sobrevive al navegador: ahí vive la sesión. */
  borrarPerfil = true,
): () => Promise<void> {
  return async () => {
    const pid = proceso.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        proceso.kill("SIGTERM");
      }
      const remate = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Ya no queda nadie del grupo: era lo que se buscaba.
        }
      }, 2000);
      remate.unref();
    }
    if (borrarPerfil) await rm(perfil, { recursive: true, force: true });
  };
}

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
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  const limpiar = crearLimpieza(proceso, perfil);

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

// ---------------------------------------------------------------------------
// Grabación en vivo: una aplicación real → cuadros JPEG con su tiempo.
// ---------------------------------------------------------------------------

/**
 * Una acción de la grabación. Es una mini-DSL en castellano, deliberadamente
 * chica: navegar, esperar contenido real, hacer clic, escribir y pausar. Lo
 * que no entra acá no se graba — una grabación no es una suite de pruebas.
 */
export interface AccionDeGrabacion {
  /** Navegar a una URL absoluta. */
  ir?: string;
  /**
   * Esperar un texto visible **y estable**: aparece, se aguanta un segundo y
   * sigue estando. Es la regla anti-loader: un esqueleto que se re-dibuja no
   * sobrevive a la pausa, y la grabación no arranca sobre un spinner.
   */
  esperar_texto?: string;
  /** Clic sobre la última coincidencia visible de un texto. */
  clic?: string;
  /** Clic sobre un selector CSS (primera coincidencia). */
  clic_selector?: string;
  /** Escribir en un campo, localizado por selector CSS. */
  escribir?: { selector: string; texto: string };
  /**
   * Subir un archivo a un `input[type=file]` (funciona aunque esté oculto).
   * `archivo` es una ruta absoluta; la habilidad la resuelve desde `salida://`.
   */
  subir_archivo?: { archivo: string; selector?: string };
  /** Una tecla suelta: "Enter" o "Tab". */
  tecla?: string;
  /** Pausa, en milisegundos. */
  esperar?: number;
}

export interface PlanDeClip {
  /**
   * Lo que pasa **fuera de cámara**: login, navegación previa, esperas. La
   * grabación arranca recién cuando esto terminó, así el clip nunca muestra
   * el formulario de acceso ni la carga inicial.
   */
  preparacion: AccionDeGrabacion[];
  /** Lo que sí se filma. */
  acciones: AccionDeGrabacion[];
  /** Cuánto sostener la pantalla final, en segundos. */
  colchon: number;
}

/** Un cuadro capturado y cuánto dura en pantalla. */
export interface CuadroDeClip {
  ruta: string;
  duracion: number;
}

export interface Grabacion {
  /** Ejecuta un plan y deja los cuadros JPEG en `destino`. */
  grabar(plan: PlanDeClip, destino: string, prefijo: string): Promise<{
    cuadros: CuadroDeClip[];
    segundos: number;
    avisos: string[];
  }>;
  /**
   * Recorre la aplicación **sin filmar** y describe lo que hay en pantalla.
   *
   * Es el reconocimiento previo al rodaje, hecho en el mismo navegador que
   * graba: el mismo perfil —o sea la misma sesión iniciada—, el mismo lienzo de
   * 1920×1080 y el mismo motor de acciones. Explorar en otro navegador es lo que
   * hacía que un texto verificado no apareciera después en la toma.
   *
   * Devuelve **texto acotado**, no el volcado del árbol de accesibilidad: en un
   * turno delegado cada resultado se reenvía en todas las vueltas que le
   * siguen, así que lo que entra gordo se paga muchas veces.
   */
  explorar(acciones: AccionDeGrabacion[], buscar?: string[]): Promise<Exploracion>;
  cerrar(): Promise<void>;
}

export interface Exploracion {
  url: string;
  titulo: string;
  /** Cada texto preguntado: si está, y si sigue estando 1,2 s después. */
  encontrados: Array<{ texto: string; visible: boolean; estable: boolean }>;
  /** Lo clickeable a la vista, tal como lo nombraría la acción `clic`. */
  clickeables: string[];
  /** El texto de la pantalla, recortado. */
  pantalla: string;
}

/** Cuánto texto de pantalla vuelve. Un volcado entero infla el turno delegado. */
const TOPE_PANTALLA = 4_000;

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Serializa un texto para meterlo dentro de una expresión evaluada. */
const comillas = (texto: string): string => JSON.stringify(texto);

/**
 * Centro visible de la última coincidencia de un texto, o de un selector.
 * Corre en la página; devuelve `null` si no hay nada clickeable.
 */
function expresionDeBusqueda(objetivo: { texto?: string; selector?: string }): string {
  if (objetivo.selector) {
    return `(() => {
      const el = document.querySelector(${comillas(objetivo.selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`;
  }
  return `(() => {
    const aguja = ${comillas(objetivo.texto ?? "")};
    const todos = [...document.querySelectorAll("button, a, [role=button], label, td, th, li, span, div, h1, h2, h3, p")];
    const visibles = todos.filter((el) =>
      el.offsetParent !== null &&
      el.innerText && el.innerText.trim().includes(aguja) &&
      el.getBoundingClientRect().height < 220);
    const el = visibles.at(-1);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
}

/**
 * Abre un Chrome para grabar una aplicación en vivo.
 *
 * Es el mismo navegador del revelado con otra cámara: en vez de calcular el
 * cuadro con las animaciones pausadas —imposible sobre una aplicación real,
 * cuyo estado avanza con la red— se filma lo que pasa con `Page.startScreencast`,
 * que entrega cada repintado con su instante. La sesión (login) vive en el
 * perfil, así que **un mismo navegador graba varios clips seguidos sin volver a
 * iniciar sesión**: la preparación de un clip empieza donde quedó el anterior.
 *
 * Con `perfil`, esa sesión sobrevive también **entre llamadas**. No es una
 * optimización de más: medido en una corrida real, once tomas de la misma
 * escena repitieron los mismos seis pasos de login —casi seis minutos de reloj—
 * porque cada grabación abría un perfil nuevo. Ningún modelo, por bueno que
 * sea, se ahorra ese trabajo: no es una decisión, es estado que se tiraba.
 *
 * El perfil que se pasa **no se borra** al cerrar; el temporal sí, como siempre.
 */
export async function abrirGrabacion(
  opciones: { chrome?: string; signal?: AbortSignal; perfil?: string } = {},
): Promise<Grabacion> {
  const binario = buscarChrome(opciones.chrome);
  if (!binario) {
    throw new Error(
      "No se encontró Google Chrome en esta máquina. La grabación de clips maneja el " +
        "navegador ya instalado; instalá Chrome o poné su ruta en ORQ_CHROME.",
    );
  }

  // Un perfil propio se crea si no existe y sobrevive al cierre: adentro está
  // la sesión que evita repetir el login en la toma siguiente.
  const perfil = opciones.perfil ?? (await mkdtemp(join(tmpdir(), "orq-grabacion-")));
  if (opciones.perfil) await mkdir(opciones.perfil, { recursive: true });
  const proceso = spawn(
    binario,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${perfil}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--window-size=${LIENZO.ancho},${LIENZO.alto}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  const limpiar = crearLimpieza(proceso, perfil, !opciones.perfil);

  let cdp: Cdp;
  try {
    const puerto = await esperarPuerto(proceso);
    cdp = await Cdp.conectar(await buscarPestaña(puerto));
    await cdp.enviar("Page.enable");
    await cdp.enviar("Runtime.enable");
    await cdp.enviar("Emulation.setDeviceMetricsOverride", {
      width: LIENZO.ancho,
      height: LIENZO.alto,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch (error) {
    await limpiar();
    throw error;
  }

  async function ejecutar(accion: AccionDeGrabacion): Promise<void> {
    opciones.signal?.throwIfAborted();

    if (accion.ir) {
      const cargada = new Promise<void>((resolve) => {
        cdp.al("Page.loadEventFired", () => resolve());
        setTimeout(resolve, CORTE.carga);
      });
      await cdp.enviar("Page.navigate", { url: accion.ir });
      await cargada;
      await pausa(900);
      return;
    }

    if (accion.esperar_texto) {
      const busca = `document.body ? document.body.innerText.includes(${comillas(accion.esperar_texto)}) : false`;
      const limite = Date.now() + 30_000;
      for (;;) {
        const visto = (await cdp.enviar("Runtime.evaluate", {
          expression: busca,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        if (visto.result?.value) {
          // Estabilidad: un esqueleto que refetchea vuelve a borrar el texto.
          await pausa(1200);
          const sigue = (await cdp.enviar("Runtime.evaluate", {
            expression: busca,
            returnByValue: true,
          })) as { result?: { value?: boolean } };
          if (sigue.result?.value) return;
        }
        if (Date.now() > limite) {
          throw new Error(`No apareció el texto "${accion.esperar_texto}" tras 30 segundos.`);
        }
        await pausa(400);
      }
    }

    if (accion.clic || accion.clic_selector) {
      // Espera implícita: la mitad de los fallos medidos fueron "tocar antes de
      // que exista" — la pantalla venía en camino y el clic instantáneo pagaba
      // el intento entero. Se reintenta hasta que el objetivo aparece, con el
      // mismo espíritu que el pickVisible del pipeline que precedió a éste.
      const expresion = expresionDeBusqueda(
        accion.clic ? { texto: accion.clic } : { selector: accion.clic_selector! },
      );
      let punto: { x: number; y: number } | null = null;
      const limite = Date.now() + 8_000;
      for (;;) {
        const centro = (await cdp.enviar("Runtime.evaluate", {
          expression: expresion,
          returnByValue: true,
        })) as { result?: { value?: { x: number; y: number } | null } };
        punto = centro.result?.value ?? null;
        if (punto || Date.now() > limite) break;
        await pausa(400);
      }
      if (!punto) {
        throw new Error(
          `No hay nada visible para el clic "${accion.clic ?? accion.clic_selector}" tras 8 segundos.`,
        );
      }
      await pausa(350);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
        await cdp.enviar("Input.dispatchMouseEvent", {
          type,
          x: punto.x,
          y: punto.y,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      }
      await pausa(700);
      return;
    }

    if (accion.escribir) {
      const enfocar = `(() => {
        const el = document.querySelector(${comillas(accion.escribir.selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.focus();
        return true;
      })()`;
      let enfocado = false;
      const limite = Date.now() + 8_000;
      for (;;) {
        const foco = (await cdp.enviar("Runtime.evaluate", {
          expression: enfocar,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        enfocado = foco.result?.value ?? false;
        if (enfocado || Date.now() > limite) break;
        await pausa(400);
      }
      if (!enfocado) {
        throw new Error(`No existe el campo "${accion.escribir.selector}" tras 8 segundos.`);
      }
      await pausa(250);
      // `insertText` dispara los eventos de entrada como un pegado: React y
      // compañía lo toman como tipeo real.
      await cdp.enviar("Input.insertText", { text: accion.escribir.texto });
      await pausa(400);
      return;
    }

    if (accion.subir_archivo) {
      // `DOM.setFileInputFiles` funciona aunque el input esté oculto, que es lo
      // habitual: el botón visible dispara un input escondido.
      const selector = accion.subir_archivo.selector ?? "input[type=file]";
      await cdp.enviar("DOM.enable").catch(() => undefined);
      const doc = (await cdp.enviar("DOM.getDocument", { depth: 1 })) as {
        root?: { nodeId?: number };
      };
      let nodeId = 0;
      const limite = Date.now() + 8_000;
      for (;;) {
        const nodo = (await cdp
          .enviar("DOM.querySelector", {
            nodeId: doc.root?.nodeId ?? 0,
            selector,
          })
          .catch(() => ({}))) as { nodeId?: number };
        nodeId = nodo.nodeId ?? 0;
        if (nodeId > 0 || Date.now() > limite) break;
        await pausa(400);
      }
      if (nodeId === 0) {
        throw new Error(`No hay ningún "${selector}" para subir el archivo tras 8 segundos.`);
      }
      await cdp.enviar("DOM.setFileInputFiles", {
        files: [accion.subir_archivo.archivo],
        nodeId,
      });
      await pausa(1500);
      return;
    }

    if (accion.tecla) {
      const codigo = accion.tecla === "Tab" ? 9 : 13;
      const key = accion.tecla === "Tab" ? "Tab" : "Enter";
      await cdp.enviar("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: codigo,
        key,
      });
      await cdp.enviar("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: codigo,
        key,
      });
      await pausa(500);
      return;
    }

    if (accion.esperar) await pausa(Math.min(accion.esperar, 20_000));
  }

  return {
    async grabar(plan, destino, prefijo) {
      const avisos: string[] = [];

      for (const [i, accion] of plan.preparacion.entries()) {
        try {
          await ejecutar(accion);
        } catch (error) {
          const detalle = error instanceof Error ? error.message : String(error);
          throw new Error(`En la preparación (paso ${i + 1}): ${detalle}`);
        }
      }

      // La cámara: cada repintado llega como JPEG con su instante. Se confirma
      // cada cuadro (`screencastFrameAck`) o Chrome deja de mandar.
      const cuadros: Array<{ datos: Buffer; instante: number }> = [];
      cdp.al("Page.screencastFrame", (params) => {
        const cuadro = params as {
          data?: string;
          sessionId?: number;
          metadata?: { timestamp?: number };
        };
        if (cuadro.data && cuadro.metadata?.timestamp) {
          cuadros.push({
            datos: Buffer.from(cuadro.data, "base64"),
            instante: cuadro.metadata.timestamp,
          });
        }
        void cdp
          .enviar("Page.screencastFrameAck", { sessionId: cuadro.sessionId ?? 0 })
          .catch(() => undefined);
      });

      const arranque = Date.now();
      await cdp.enviar("Page.startScreencast", {
        format: "jpeg",
        quality: 85,
        maxWidth: LIENZO.ancho,
        maxHeight: LIENZO.alto,
        everyNthFrame: 1,
      });

      try {
        for (const [i, accion] of plan.acciones.entries()) {
          try {
            await ejecutar(accion);
          } catch (error) {
            const detalle = error instanceof Error ? error.message : String(error);
            throw new Error(`En cámara (paso ${i + 1}): ${detalle}`);
          }
        }
        await pausa(Math.max(0, plan.colchon * 1000));
      } finally {
        await cdp.enviar("Page.stopScreencast").catch(() => undefined);
      }

      const segundos = (Date.now() - arranque) / 1000;
      if (cuadros.length === 0) {
        throw new Error(
          "La grabación no capturó ningún cuadro: la página no repintó nada. " +
            "Meté una acción visible (un clic, un scroll) o navegá dentro de la escena.",
        );
      }

      // Cada cuadro dura hasta el siguiente; el último sostiene el colchón.
      const salida: CuadroDeClip[] = [];
      for (const [i, cuadro] of cuadros.entries()) {
        const proximo = cuadros[i + 1];
        const duracion = proximo
          ? Math.max(0.02, proximo.instante - cuadro.instante)
          : Math.max(0.2, segundos - (cuadro.instante - cuadros[0]!.instante));
        const ruta = join(destino, `${prefijo}-${String(i).padStart(4, "0")}.jpg`);
        await writeFile(ruta, cuadro.datos);
        salida.push({ ruta, duracion });
      }

      return { cuadros: salida, segundos, avisos };
    },

    async explorar(acciones, buscar = []) {
      for (const [i, accion] of acciones.entries()) {
        try {
          await ejecutar(accion);
        } catch (error) {
          const detalle = error instanceof Error ? error.message : String(error);
          throw new Error(`En el paso ${i + 1}: ${detalle}`);
        }
      }

      const leer = async <T>(expresion: string): Promise<T | null> => {
        const r = (await cdp.enviar("Runtime.evaluate", {
          expression: expresion,
          returnByValue: true,
        })) as { result?: { value?: T } };
        return r.result?.value ?? null;
      };

      const encontrados: Exploracion["encontrados"] = [];
      for (const texto of buscar) {
        const hay = `document.body ? document.body.innerText.includes(${comillas(texto)}) : false`;
        const visible = (await leer<boolean>(hay)) ?? false;
        // La estabilidad es la regla anti-loader de siempre: un esqueleto que
        // refetchea muestra el texto y lo borra. Un texto visible pero no
        // estable no sirve como ancla de `esperar_texto`, y descubrirlo acá
        // cuesta un segundo — descubrirlo filmando cuesta la toma entera.
        let estable = false;
        if (visible) {
          await pausa(1200);
          estable = (await leer<boolean>(hay)) ?? false;
        }
        encontrados.push({ texto, visible, estable });
      }

      // Ojo con las barras adentro de este template: viaja como código a
      // Runtime.evaluate, así que una barra sin escapar se la come el template
      // literal. Con la regex de espacios escrita sin escapar llegaba /s+/g y
      // le comía las eses a cada palabra: "Orquestador" volvía "Orque tador".
      // Y nada de backticks acá adentro, que cierran el template.
      const clickeables =
        (await leer<string[]>(`(() => {
          const els = [...document.querySelectorAll("button, a, [role=button], label, th, li")];
          const textos = els
            .filter((el) => el.offsetParent !== null && el.innerText && el.innerText.trim())
            .map((el) => el.innerText.trim().replace(/\\s+/g, " "))
            .filter((t) => t.length > 0 && t.length < 60);
          return [...new Set(textos)].slice(0, 60);
        })()`)) ?? [];

      const pantalla = (await leer<string>("document.body ? document.body.innerText : ''")) ?? "";

      return {
        url: (await leer<string>("location.href")) ?? "",
        titulo: (await leer<string>("document.title")) ?? "",
        encontrados,
        clickeables,
        pantalla: pantalla.replace(/\n{3,}/g, "\n\n").slice(0, TOPE_PANTALLA),
      };
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
