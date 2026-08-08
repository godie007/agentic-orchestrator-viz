/**
 * La mezcla de audio de un video: voces ubicadas y cama musical debajo.
 *
 * Vive aparte porque la comparten los dos renders —el de ASS (`video.ts`) y el
 * de láminas HTML (`estudio.ts`)— y porque acá adentro hay tres trampas que ya
 * costaron caro. Duplicar esta cadena garantiza que la próxima corrección
 * arregle un video y deje el otro roto, que es exactamente lo que pasó con los
 * íconos hasta que pasaron a salir de un solo catálogo.
 *
 * No abre archivos ni ejecuta nada: devuelve el texto del `filter_complex`. Es
 * una función pura, y por eso se puede fijar con tests sin sintetizar una sola
 * palabra.
 */

/**
 * La cama, medida en sonoridad y no en volumen.
 *
 * Un `volume=0.22` fijo no significa nada: una pista comprada y masterizada
 * llega a −14 LUFS y una sintetizada acá al lado a −24, así que el mismo número
 * deja una inaudible y la otra encima de la voz. Se normaliza a una sonoridad
 * objetivo y recién ahí se la acuesta bajo la narración: así **cualquier** pista
 * que dejes en la biblioteca suena igual de presente.
 */
export const MUSICA = { lufs: -26, entrada: 2.5, salida: 3.5 } as const;

/**
 * Se fija el formato de la mezcla de voz: la música y el compresor de cadena
 * lateral exigen que las dos entradas coincidan, y Kokoro entrega mono.
 */
const FORMATO = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

const LIMITADOR = "alimiter=level_in=1:level_out=0.92";

export interface PedidoSonido {
  /** Dónde arranca cada línea hablada, en segundos. Su orden es el de las entradas. */
  inicios: readonly number[];
  /** Largo del video, en segundos. */
  total: number;
  /** Índice de entrada de la música en ffmpeg, o `-1` si se filma en silencio. */
  indiceMusica: number;
  /** Índice de la primera entrada de voz. Antes va el fondo. */
  primeraVoz?: number;
}

/**
 * El grafo de audio, listo para pegar en un `filter_complex`. Termina en `[aud]`.
 *
 * Cada voz se coloca en su instante exacto y se suman las pistas: no hay
 * concatenación, así que un error de milisegundos no arrastra al resto.
 */
export function construirSonido(pedido: PedidoSonido): string {
  const primera = pedido.primeraVoz ?? 1;
  const total = pedido.total.toFixed(2);

  const pistas = pedido.inicios.map(
    (inicio, i) =>
      `[${i + primera}:a]aresample=44100,adelay=delays=${Math.round(inicio * 1000)}:all=1[v${i}]`,
  );

  const voz =
    pedido.inicios.length > 0
      ? `${pistas.join(";")};${pedido.inicios.map((_, i) => `[v${i}]`).join("")}` +
        `amix=inputs=${pedido.inicios.length}:duration=longest:normalize=0,` +
        `apad,atrim=0:${total},${FORMATO}[voz]`
      : `anullsrc=r=44100:cl=stereo,atrim=0:${total},${FORMATO}[voz]`;

  if (pedido.indiceMusica < 0) return `${voz};[voz]${LIMITADOR}[aud]`;

  return [
    voz,
    "[voz]asplit=2[vozmix][vozlado]",
    // `loudnorm` devuelve 192 kHz sí o sí, así que el `aresample` va **después**:
    // antes, la cama entraba a la mezcla al triple de velocidad de muestreo y
    // sonaba como una cinta acelerada.
    `[${pedido.indiceMusica}:a]aresample=44100,${FORMATO},atrim=0:${total},` +
      `loudnorm=I=${MUSICA.lufs}:TP=-3:LRA=11,aresample=44100,${FORMATO},` +
      `afade=t=in:st=0:d=${MUSICA.entrada},` +
      `afade=t=out:st=${Math.max(0, pedido.total - MUSICA.salida).toFixed(2)}:d=${MUSICA.salida}[cama]`,
    // La música se aparta sola cuando alguien habla. Sin esto hay que elegir
    // entre una cama inaudible y una voz tapada, y las dos opciones suenan a
    // video hecho a las apuradas.
    "[cama][vozlado]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[camaduck]",
    `[vozmix][camaduck]amix=inputs=2:duration=first:normalize=0,${LIMITADOR}[aud]`,
  ].join(";");
}
