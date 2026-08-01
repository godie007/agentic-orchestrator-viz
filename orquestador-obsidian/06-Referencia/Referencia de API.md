---
tags: [referencia]
aliases: [API, Endpoints, REST]
---

# Referencia de API

`apps/server/src/routes.ts`. Base: `http://localhost:3001`.
El contrato y sus particularidades están en [[API HTTP y SSE]].

## Salud y catálogo

| Método | Ruta | Qué devuelve |
|---|---|---|
| `GET` | `/api/health` | `{ ok: true }` |
| `GET` | `/api/providers` | proveedores configurados y sus tiers resueltos |
| `GET` | `/api/models` | catálogo vivo de modelos |

## Empresas

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/companies` | listar |
| `GET` | `/api/companies/resumen` | **una línea por proyecto**: cuentas, peso en disco, última corrida y si tiene una viva. Alimenta la pantalla de Proyectos |
| `GET` | `/api/companies/:id` | una, con departamentos, roles, políticas, MCP |
| `POST` | `/api/companies` | crear — **siembra las herramientas built-in**, o el proyecto nace sin nada que asignarle a un agente |
| `PATCH` | `/api/companies/:id` | modificar |
| `DELETE` | `/api/companies/:id` | borrar — se lleva corridas, artefactos, **conexiones MCP y la carpeta de salida**. Responde **409** si hay una corrida en curso |
| `GET` | `/api/companies/:id/blueprint` | la empresa entera como JSON, **sin credenciales** |
| `POST` | `/api/companies/import` | importar un blueprint |

## Misiones

| Método | Ruta |
|---|---|
| `GET` | `/api/companies/:companyId/misiones` |
| `POST` | `/api/companies/:companyId/misiones` |
| `PATCH` | `/api/companies/:companyId/misiones/:id` |
| `DELETE` | `/api/companies/:companyId/misiones/:id` |
| `POST` | `/api/companies/:companyId/misiones/:id/run` — dispararla a mano |

Ver [[Misiones programadas]].

## Herramientas, solicitudes y memoria

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/companies/:companyId/tools` | el catálogo de la empresa |
| `GET` | `/api/companies/:companyId/requests` | `AgentRequest` pendientes y resueltas |
| `POST` | `/api/companies/:companyId/requests/:id` | resolver una — **también hay que reflejarlo en `RunState`** |
| `GET` | `/api/companies/:companyId/learnings` | la memoria |
| `POST` | `/api/companies/:companyId/learnings` | sembrar o agregar |
| `DELETE` | `/api/companies/:companyId/learnings/:id` | borrar |

## MCP

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/companies/:companyId/mcp/health` | estado de cada servidor |
| `POST` | `/api/companies/:companyId/mcp/:serverId/reconnect` | reconectar |
| `POST` | `/api/companies/:companyId/mcp/probe` | **probador manual**: ejecutar una tool sin arrancar la empresa |

## Directorio de salida

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/companies/:companyId/exports` | el árbol de archivos |
| `POST` | `/api/companies/:companyId/exports/folders` | crear carpeta |
| `DELETE` | `/api/companies/:companyId/exports/*` | borrar — **sin las reglas de jerarquía** |
| `GET` | `/api/companies/:companyId/exports/*` | descargar; con `?inline` se dibuja en el navegador |
| `GET` | `/api/companies/:companyId/exports-preview/*` | vista previa (Word → texto, video, audio, imágenes) |
| `POST` | `/api/companies/:companyId/exports-publicar/*` | mover a `publicado/` |
| `POST` | `/api/companies/:companyId/exports-vaciar` | borrar lo que generó la empresa, **conservando lo que subiste vos** |

> [!warning] `?inline` no es opcional para el iframe
> Un `Content-Disposition: attachment` dentro de un iframe dispara la descarga en
> vez de dibujarse.

## Corridas

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/runs` | crear — `{ companyId, objective, mode?, maxTicks?, budgetUsd?, cronIntervalMs? }` |
| `GET` | `/api/runs` | listar |
| `GET` | `/api/runs/:id` | una, con su snapshot autoritativo |
| `GET` | `/api/runs/:id/events` | la traza guardada, ordenada por `seq` — es el replay |
| `DELETE` | `/api/runs/:id` | borrar — **nunca se lleva entregables**; sólo `running` no se puede |
| `DELETE` | `/api/companies/:companyId/runs/terminadas` | limpiar todas las terminadas de esa empresa |
| `DELETE` | `/api/runs/terminadas` | lo mismo, **de todas las empresas**. Convive con `/api/runs/:id` porque el router resuelve el segmento estático antes que el paramétrico |

## Mantenimiento

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/mantenimiento` | qué hay para limpiar, **sin borrar nada**: peso de la base, filas sueltas por tabla, carpetas sin empresa y corridas terminadas |
| `POST` | `/api/mantenimiento/purgar` | `{ residuos?, carpetas?: string[], corridas?, compactar? }` |

`purgar` sólo borra carpetas que el diagnóstico marcó como residuales en ese
momento; lo demás vuelve en `rechazadas` con el motivo. El peso de la base se
mide **antes de tocar nada**, así que `base.antes === base.despues` sin
`compactar` es correcto y no un error. Ver [[Limpieza y mantenimiento]].
| `POST` | `/api/runs/:id/inject` | inyectarle un mensaje a un agente — `{ toRoleId, subject, body }` |
| `POST` | `/api/runs/:id/approvals/:approvalId` | resolver — `{ decision: "grant"\|"deny", resolution }` |

### Acciones de ciclo de vida

`POST /api/runs/:id/<acción>` — registradas en bucle sobre la lista de acciones
(`tick`, `start`/`resume`, `pause`, `stop`). Los controles de la UI se muestran
**según el estado**: ofrecer "pausar" sobre una corrida terminada obliga a
adivinar cuál sirve.

## SSE

| Ruta | Alcance |
|---|---|
| `GET /api/runs/:id/stream` | eventos de **una corrida** |
| `GET /api/mcp/stream` | salud de MCP, **global** — sigue emitiendo sin corridas |

## Trampa del cliente

> [!danger] `content-type: application/json` con body vacío
> Fastify responde **400**. `apps/web/src/api.ts` sólo pone el header cuando hay
> cuerpo; si lo cambiás, **todos los DELETE se rompen**.

## Enlaces

- [[API HTTP y SSE]]
- [[Referencia de esquemas]] — la forma de los payloads
- [[Referencia de eventos]] — lo que viaja por SSE
