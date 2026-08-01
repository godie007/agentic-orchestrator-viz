---
tags: [producto]
aliases: [Roadmap, Próximos pasos]
---

# Hoja de ruta

No es un compromiso de fechas: es la lista ordenada de lo que hoy falta, con el
motivo. Lo que ya está hecho vive en [[Estado del producto]].

## Prioridad alta — cierra huecos verificados

### 1. Corrida completa con modelos pagos
Es el único item de [[Estado del producto]] marcado como no verificado.
Requisito: crédito en OpenRouter y los roles coordinadores en `standard` (nunca
`cheap` para quien coordina — ver [[Capa LLM y tiers]]).

### 2. Persistir el estado vivo de una corrida
Hoy la traza se persiste pero el estado vivo está en memoria: reiniciar el
servidor mata la corrida. Falta materializar `RunState` para poder **continuar**,
no sólo reproducir. Toca `packages/engine/src/state.ts` y
`apps/server/src/runtime.ts`.

### 3. Tope de gasto evaluado durante el turno
Hoy se chequea **antes** de cada turno (`ledger.assertWithinBudget()`), así que
una sola llamada cara puede pasarse. Falta un corte por streaming, o una
estimación previa del costo de la llamada.

## Prioridad media — calidad de lo que ya funciona

- **Migraciones versionadas.** El esquema es idempotente hoy; el archivo
  `apps/server/src/migrate.ts` está reservado para cuando haga falta una
  migración de verdad. Ver [[Base de datos]].
- **Más proveedores de imágenes.** El endpoint de NVIDIA hoy no responde; hay
  corte por tiempo (`CORTE_MS`) para que eso no cuelgue la corrida, pero el
  fallback ordenado merece más opciones. Ver [[Producción audiovisual]].
- **Ampliar el set de íconos y visuales.** `ICONOS_DISPONIBLES` y los visuales de
  `skills/visuales.ts` son un conjunto curado; agregar uno es agregar un trazo
  en una caja de 100×100. Ver [[Íconos y visuales vectoriales]].
- **Reglas de permiso más finas.** Hoy `puedeBorrar` resuelve contra
  `role.authority` con tres niveles. Falta poder decir "este rol puede borrar en
  esta carpeta". Ver [[Habilidades de producción]].

## Prioridad baja — sólo si aparece la necesidad

- Un linter. Hoy `typecheck` con `strict` + `noUncheckedIndexedAccess` alcanza.
- Compilar los `packages/`. Hoy su `exports` apunta directo a `./src/index.ts` y
  los consumen tsx y Vite; agregar un paso de build sin necesidad real es costo
  puro. Ver [[Mapa del monorepo]].
- Un proveedor "suscripción Claude". Es un archivo nuevo en
  `packages/llm/src/adapters/` — ver [[ADR-001 No usar Claude Agent SDK]] para
  por qué hoy no está.

## Descartado a propósito

Estas no son omisiones: se evaluaron y se rechazaron. El motivo importa tanto
como la decisión.

| Idea | Por qué no |
|---|---|
| Navegador headless para maquetar el video | 150 MB de dependencia para seis placas de texto que ffmpeg ya sabe dibujar con libass |
| Emojis en los videos | libass los dibuja en monocromo o los saltea según la fuente instalada: un video que en una máquina muestra un cohete y en otra un cuadrado no es una salida confiable ([[Íconos y visuales vectoriales]]) |
| Que el orquestador descargue música | la música tiene licencia, y meterle un mp3 al video de una empresa la mete en un problema que no sabe que tiene ([[Música y narración]]) |
| Un archivo por versión de entregable (`key-v3.pdf`) | cada re-exportación dejaba otro archivo y pedir un PDF terminaba en v1, v2 y v3 conviviendo. La versión va en la portada |
| Que un agente pueda publicar | "aprobado" tiene que ser un hecho verificable en el disco, no un estado que hay que creer ([[ADR-008 Publicar lo decide una persona]]) |
| Guardar secretos de MCP en la base | una empresa exportada a JSON llevaría credenciales. Se guardan **por referencia** ([[Seguridad]]) |
| SMTP directo para el correo | el flujo de n8n decide con qué cuenta sale; el orquestador no administra casillas ([[ADR-007 Correo por webhook de n8n]]) |

## Enlaces

- [[Estado del producto]]
- [[Decisiones de arquitectura]]
- [[Guía de contribución]]
