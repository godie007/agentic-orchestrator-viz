---
tags: [operación]
aliases: [Troubleshooting, Diagnóstico, Problemas]
---

# Diagnóstico de problemas

Ordenado por dónde se ve el síntoma. Las causas están explicadas en detalle en
[[Trampas conocidas]].

## El proveedor LLM

| Síntoma | Causa | Qué hacer |
|---|---|---|
| la corrida muere en el tercer ciclo sin producir nada | **402 a todo**: cuenta sin crédito. Con saldo negativo, el cupo gratuito sólo tolera pedidos triviales | `npm run check:llm`; recargar destraba |
| turnos lentos y errores 429 | límites del tier `free` | el motor reintenta con backoff; pasá a `standard` para una corrida larga |
| un agente pierde el turno y el resto sigue | es el comportamiento esperado: un proveedor saturado no tumba la corrida | mirá el `log` de nivel `warn` en la actividad |
| el ciclo entero tarda once minutos | una llamada lenta bloquea el tick — el más lento manda | `TurnDeps.llmTimeoutMs` la corta |
| el tier resuelve a un modelo raro | mirá `npm run check:models` con el motivo de la elección | fijá `modelSlug` exacto desde la UI |

## Los agentes

| Síntoma | Causa |
|---|---|
| el CEO se va a descargar PDFs al azar en vez de delegar | tier `cheap` en un rol que **coordina**. Usá `cheap` sólo para ejecutores |
| el mismo agente toma turno catorce ciclos sin ejecutar nada | livelock por tarea abierta. El scheduler ahora corta a los dos turnos vacíos |
| diez mensajes a la misma persona en una corrida | ya no pasa: `send_message` rechaza insistirle a quien no contestó |
| el agente insiste con una llamada que siempre falla | el corte por repetición lo frena a la tercera |
| el agente dice que no encuentra `export_video` | la habilidad no está en `role.toolIds` **ni** en la tabla `tools`. Ver [[Base de datos]] |
| un agente al que se le pidió un PDF dice que no tiene la herramienta | el router acotaba mal — ya corregido, pero verificá `tool.selection` en la traza |
| el agente informa que no pudo algo que sí hizo | usá `check_activity`: registra el resultado **real** |
| el auditor "encuentra" errores que no existen | le falta la fecha o la fuente. Ver [[CU-04 Control de calidad entre agentes]] |
| tres entregables fragmentados (`-ciclo3`, `_v2`) | la guardia de claves-variante lo frena; si aparece, revisá el tier |
| la corrida gastó 534k tokens de entrada para 2k de salida | el memo de lecturas derrotado por un argumento inventado — ya corregido |
| el agente vuelve a preguntar lo mismo al ciclo siguiente | la respuesta salió como "aprobación concedida" y el dato quedó escondido — ya corregido |

## La corrida

| Síntoma | Causa |
|---|---|
| una corrida detenida dice "está en curso" | se leyó `active.run` en vez de `orchestrator.snapshot` |
| retomar una corrida es un no-op | estaba en `awaiting_approval` sin nada pendiente — `runContinuous` se destraba sola |
| la corrida espera para siempre una respuesta ya dada | se resolvió por la API sin reflejarlo en `RunState.resolverSolicitud` |
| una corrida no sobrevive al reinicio | **es así**: el estado vivo está en memoria. La traza queda persistida |
| se contestó una solicitud y no llegó a ninguna bandeja | la corrida ya había cerrado: quedó como `Learning` de la empresa |
| eventos de una corrida que ya no existe | se borró sin soltarla del runtime (`olvidarCorrida`) |
| "completed" en 3 ciclos sin entregable | es un pedido perdido, no un éxito. Mirá los reencolados |

## La UI

| Síntoma | Causa |
|---|---|
| **el organigrama está vacío** — nodos en el DOM, ninguno en pantalla | React Flow perdía la medición al recibir objetos nuevos en cada render. `OrgGraph` reusa con `useNodesState` |
| un nodo queda "pensando…" para siempre | falta `agent.turn_end` — se emite en `finally` |
| todos los roles nuevos apilados en una esquina | nacen en (0,0); `autoLayout` los acomoda al detectar posiciones repetidas |
| la página desborda a lo ancho | falta `min-w-0` en `Panel` o en una columna de la grilla |
| **todos los DELETE devuelven 400** | `content-type: application/json` con body vacío. `api.ts` sólo pone el header cuando hay cuerpo |
| el PDF dispara la descarga en vez de dibujarse | falta `?inline` |
| la tabla del Word se deshace en la vista previa | `</w:p>` dentro de una celda hay que descartarlo **antes** que los genéricos |

## El servidor

| Síntoma | Solución |
|---|---|
| sirve código viejo | `lsof -ti:3001 \| xargs kill -9` — `pkill -f` no siempre alcanza |
| falla al arrancar por una variable | el entorno se valida al arrancar, a propósito. Arreglá el `.env` |
| la UI se corre de puerto | no lo hace: Vite usa `strictPort: true` |

## Los archivos y el video

| Síntoma | Causa |
|---|---|
| el video sale en silencio con música en la carpeta | pistas en subcarpetas — la biblioteca se recorre en profundidad; verificá `MUSICA_DIR` |
| la cama suena a cinta acelerada | `aresample` antes de `loudnorm`, que devuelve 192 kHz sí o sí |
| la cama tapa la voz, o es inaudible | volumen fijo en vez de normalizar a LUFS |
| el video dice ":objetivo:" en voz alta | la marca de ícono quedó sola en su renglón: es un párrafo, y un párrafo es voz en off |
| un personaje lee en voz alta los nombres de los demás | el diálogo se escribió con renglones en blanco entre líneas |
| la portada anuncia "(v4)" y el título real es una placa del medio | encabezado de documento arriba del guion |
| el PDF tiene el doble de páginas | se escribió debajo del margen inferior |
| "✅ Sí" salió como "' Sí" | emoji con fuente WinAnsi — se descarta con `sinEmoji` |
| las palabras de una tabla se parten al medio | falta el ancho mínimo por columna |
| media tabla maquetada y el resto con pipes a la vista | una línea en blanco entre grupos de filas cortaba la tabla |
| un candado parece una mancha, o un bolso | el agujero necesita el contorno invertido; y ojo con superponer contornos |
| los rótulos de un visual caen un renglón abajo | en SVG la `y` es la línea de base, en ASS es el techo |
| una persona con el teléfono flotando | se movió la figura sin mover los props |

## MCP

| Síntoma | Causa |
|---|---|
| semáforo en `error` | comando mal, ruta inexistente, o la variable de `envRefs` no está en el entorno |
| certificado rechazado en un servidor HTTP interno | falta `caPath` |
| `npm audit` grita por `@hono/node-server` | **no es alcanzable** — leé `package.json → auditNotes` antes de tocarlo |

Probá con el **probador manual** del MCP Hub antes de gastar una corrida.

## Enlaces

- [[Trampas conocidas]] — el detalle de cada causa
- [[Comandos]]
- [[Estado del producto]]
