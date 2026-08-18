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
 *
 * Y el número es el resultado de medir dos veces y errarle a las dos.
 *
 * Con −26 y ducking `ratio=10` la cama quedaba en −40 dB: inaudible, y el video
 * parecía sin música. Corregir el ducking y subir a −20 la puso **encima de la
 * narración**: medido sobre el video terminado, los pasajes de música sola
 * quedaban a −24 dB contra picos de voz a −20, o sea apenas 4-5 dB de
 * diferencia. Una cama de fondo tiene que estar 10-12 dB por debajo de la voz;
 * a 4-5 no acompaña, compite.
 *
 * El número correcto sale de esa cuenta, no del gusto: con el ducking ya
 * arreglado (`ratio=4`), −26 deja los pasajes instrumentales alrededor de −30 y
 * la cama bajo la voz cerca de −34. Se escucha cuando la voz calla y no pelea
 * cuando habla. **Verificalo midiendo el valle entre dos frases**, nunca el
 * promedio del video ni la cola, que trae el fade y siempre da bajo.
 */
export const MUSICA = { lufs: -26, entrada: 2.5, salida: 3.5 } as const;

/**
 * Cuánto se aparta la cama cuando alguien habla.
 *
 * Estos cuatro números decidieron un video entero en el que **la música no se
 * escuchaba**, y la causa era la suma de dos errores que por separado parecían
 * prudentes: la cama nacía a −26 LUFS —ya bajo para una cama— y encima entraba
 * a un `sidechaincompress` con `ratio=10`, que a esa altura no es un ducker
 * sino una compuerta. Medido sobre el video real: en la cola, sin una sola
 * palabra encima, la música quedaba en −40 dB. Inaudible en cualquier parlante.
 *
 * Un ducking musical baja la cama entre 8 y 10 dB bajo la voz, no 20. `ratio=4`
 * comprime en vez de cortar; el `attack` corto agarra la primera sílaba (si no,
 * cada frase arranca con un pico de música por encima de la voz) y el `release`
 * de 300 ms la devuelve **entre frase y frase**, que es justo cuando una cama
 * tiene que oírse. Con `release=400` y una narración corrida, la música vivía
 * hundida de punta a punta.
 */
const DUCKING = { threshold: 0.06, ratio: 4, attack: 5, release: 300 } as const;

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
    `[cama][vozlado]sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}:` +
      `attack=${DUCKING.attack}:release=${DUCKING.release}[camaduck]`,
    `[vozmix][camaduck]amix=inputs=2:duration=first:normalize=0,${LIMITADOR}[aud]`,
  ].join(";");
}
