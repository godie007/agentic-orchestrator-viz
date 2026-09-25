import type { ComandosRepositorio, TipoServicio } from "@orq/shared";
import type { ToolContext } from "../types.js";

/**
 * Lo que el servidor le presta a las herramientas de código.
 *
 * Las herramientas no saben dónde vive un repo, cómo se llama su `--git-dir`
 * ni quién tiene el arriendo de escritura: todo eso lo resuelve el servidor,
 * igual que `SkillStorage` resuelve la salida. Así `packages/tools` sigue sin
 * decidir rutas, y el saneo de lo que propone un modelo vive en un solo lugar.
 */

/** Un repo con su sesión abierta, listo para trabajar. */
export interface EspacioDeCodigo {
  repoId: string;
  nombre: string;
  /** Raíz del worktree de la sesión, absoluta y real (sin symlinks). */
  dir: string;
  rama: string;
  /** Commit del que partió la sesión: contra esto se mide "qué cambió". */
  baseSha: string;
  ramaBase: string;
  comandos: ComandosRepositorio;
  pendienteDeConfirmar: boolean;
}

export interface ResultadoGitCodigo {
  ok: boolean;
  codigo: number;
  stdout: string;
  stderr: string;
}

export interface ResultadoComando {
  /** `null` si no llegó a terminar (corte por tiempo, no se pudo lanzar). */
  codigo: number | null;
  /** Cabeza corta + cola larga: los fallos se imprimen al final. */
  salida: string;
  duracionMs: number;
  cortadoPorTiempo: boolean;
  /** Si corrió con `sandbox-exec`, o por qué no. */
  aislamiento: "sandbox" | "sin-aislamiento";
  /** Dónde quedó el log completo, relativo al proyecto. */
  log: string | null;
  /** No se pudo lanzar: el ejecutable no existe, el sandbox no arrancó. */
  error?: string;
  /**
   * El resultado es de una corrida anterior del mismo comando sobre el mismo
   * árbol: hace cuánto se corrió. Ver `ejecutar` en el servidor.
   */
  reutilizadoHaceMs?: number;
}

/** Un servicio del repo visto por un agente: qué es, si está levantado y dónde. */
export interface ServicioParaAgente {
  id: string;
  nombre: string;
  tipo: TipoServicio;
  carpeta: string;
  estado: "detenido" | "preparando" | "arrancando" | "listo" | "fallo";
  /** Dónde responde, si está levantado. */
  url: string | null;
  /** Por qué falló, o qué se redirigió al arrancar. */
  detalle: string | null;
}

export interface PedidoHttp {
  metodo: string;
  ruta: string;
  cuerpo?: string;
  cabeceras?: Record<string, string>;
}

export interface RespuestaHttp {
  estado: number;
  cabeceras: Record<string, string>;
  cuerpo: string;
  ms: number;
}

export interface CodigoStorage {
  /** Los repos del proyecto y, si la hay, su sesión abierta. */
  listar(): Promise<
    Array<{
      id: string;
      nombre: string;
      ramaBase: string;
      comandos: ComandosRepositorio;
      pendienteDeConfirmar: boolean;
      sesion: { rama: string; commits: number | null } | null;
      servicios: ServicioParaAgente[];
    }>
  >;
  /**
   * El espacio de trabajo de un repo: abre la sesión si no había. Con un solo
   * repo en el proyecto, `repo` es opcional.
   */
  espacio(
    repo: string | undefined,
    ctx: ToolContext,
  ): Promise<{ ok: true; espacio: EspacioDeCodigo } | { ok: false; motivo: string }>;
  /**
   * ¿Este turno tiene el arriendo de escritura? Uno por repo y por turno: dos
   * agentes editando el mismo árbol a la vez se pisan, y uno corre los tests
   * sobre la edición a medio hacer del otro.
   */
  puedeEscribir(repoId: string, ctx: ToolContext): { ok: true } | { ok: false; motivo: string };
  /** Git dentro del worktree, con `--git-dir` explícito y la config segura. */
  git(espacio: EspacioDeCodigo, args: string[], opciones?: { entrada?: string }): Promise<ResultadoGitCodigo>;
  /** Corre un comando ya autorizado. Uno a la vez por repo. */
  ejecutar(
    espacio: EspacioDeCodigo,
    argv: string[],
    opciones: {
      corteMs: number;
      signal?: AbortSignal;
      repetir?: boolean;
      /** Subcarpeta ya validada (relativa, dentro del worktree): en un monorepo cada parte tiene sus tests. */
      carpeta?: string;
    },
  ): Promise<ResultadoComando>;
  /** Los servicios del repo con su estado. Levantarlos lo decide una persona. */
  servicios(repoId: string): Promise<ServicioParaAgente[]>;
  /** Las últimas líneas de la salida de un servicio, con los secretos tapados. */
  logsDeServicio(
    repoId: string,
    servicioId: string,
    lineas: number,
  ): Promise<{ ok: true; texto: string } | { ok: false; motivo: string }>;
  /** Un pedido HTTP a un servicio levantado. Sólo a ése: no es un cliente HTTP general. */
  probarServicio(
    repoId: string,
    servicioId: string,
    pedido: PedidoHttp,
  ): Promise<{ ok: true; respuesta: RespuestaHttp } | { ok: false; motivo: string }>;
  /** Consume un permiso de una sola vez, ya usado. */
  consumirUnaVez(repoId: string, argv: string[]): Promise<void>;
  /** Crea un repo vacío para un programa nuevo. Ver `crear_repositorio`. */
  crear(
    nombre: string,
    descripcion: string,
    ctx: ToolContext,
  ): Promise<{ ok: true; repo: { id: string; nombre: string } } | { ok: false; motivo: string }>;
}
