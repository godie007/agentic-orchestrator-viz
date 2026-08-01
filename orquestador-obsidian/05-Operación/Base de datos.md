---
tags: [operación]
aliases: [DB, SQLite operación]
---

# Base de datos

SQLite en `data/orquestador.db` (configurable con `DATABASE_URL`), vía
`better-sqlite3`. El esquema técnico está en [[Persistencia y esquema SQL]];
esta nota es operativa.

## No hay migraciones versionadas

El esquema es **idempotente** y lo aplica el constructor de `Store`
(`apps/server/src/db.ts`). Arrancar el servidor con una base vacía la crea.

```bash
npm run db:migrate     # aplica el esquema y lista las tablas con sus filas
```

Sirve para crear o inspeccionar la base **sin levantar el servidor**. Si algún
día hace falta una migración de verdad, entra en `apps/server/src/migrate.ts`.

## Sembrar

```bash
npm run db:seed        # Codytion S.A. — 7 roles, propuesta comercial
npm run db:estudio     # Estudio Codytion — 4 roles, produce un video
```

> [!warning] Al armar una empresa por código, registrá también las habilidades
> `npm run db:seed` filtraba sólo `capability`, y entonces sus roles **no podían
> exportar nada**: el agente explicaba que no encontraba `export_video`. Las de
> `origin: "skill"` tienen que estar en la tabla `tools` y en `role.toolIds`. Ver
> [[Invariantes de arquitectura]] §7.

## Inspeccionar a mano

```bash
sqlite3 data/orquestador.db ".tables"
sqlite3 data/orquestador.db "SELECT id, name FROM companies;"
sqlite3 data/orquestador.db "SELECT status, tick, spent_usd FROM runs ORDER BY started_at DESC LIMIT 5;"
sqlite3 data/orquestador.db "SELECT key, version, title FROM artifacts WHERE company_id='...';"
```

Para ver la traza de una corrida en orden:

```bash
sqlite3 data/orquestador.db "SELECT seq, type FROM events WHERE run_id='...' ORDER BY seq;"
```

`seq` es lo que hace posible el replay.

## Limpiar

| Qué | Cómo | Se lleva |
|---|---|---|
| una corrida | `DELETE /api/runs/:id` | eventos, mensajes, tareas, aprobaciones, ledger. **Nunca entregables** |
| todas las terminadas | `DELETE /api/companies/:companyId/runs/terminadas` | ídem |
| todas las terminadas, de **todas** las empresas | `DELETE /api/runs/terminadas` | ídem |
| una empresa | `DELETE /api/companies/:id` | todo: corridas, artefactos, **conexiones MCP y su carpeta de salida** |
| lo que produjo una empresa | `POST /api/companies/:id/exports-vaciar` | los archivos generados; **conserva lo que subiste vos** |
| residuos de borrados viejos | `POST /api/mantenimiento/purgar` | filas sueltas y carpetas sin empresa |
| todo | borrar `data/orquestador.db` y volver a sembrar | todo |

Desde la UI está todo junto en **Empresa → Mantenimiento**, con el diagnóstico
antes de cada botón. Ver [[Limpieza y mantenimiento]].

> [!info] Limpiar corridas no cuesta entregables
> `artifacts.company_id` existe para eso. Ver
> [[Invariantes de arquitectura]] §12.

> [!warning] Una corrida `running` no se puede borrar
> Y al borrar una, hay que soltarla del runtime (`olvidarCorrida`) o queda un
> orquestador vivo escribiendo eventos de algo que ya no existe.

## El archivo no se achica solo

SQLite no le devuelve al sistema el espacio de lo que borrás: lo marca libre y lo
reusa. Después de purgar una corrida de miles de eventos el archivo pesa lo
mismo. Para compactarlo, `POST /api/mantenimiento/purgar` con `compactar: true`
(o `VACUUM` a mano) — **nunca dentro de una transacción**, SQLite no lo admite.

## Respaldo

La base es un archivo: copialo. Pero **el archivo no es todo**: los entregables
en disco viven en `data/exports/<empresa>/`, incluidos el logo, las imágenes
generadas y la carpeta `publicado/`. Un respaldo completo es:

```bash
cp -r data/ respaldo-$(date +%F)/     # base + exports + música
```

## Portar una empresa a otra instalación

No hace falta copiar la base:

```bash
curl localhost:3001/api/companies/<id>/blueprint > empresa.json
# en la otra instalación:
curl -X POST localhost:3001/api/companies/import -H 'content-type: application/json' -d @empresa.json
```

El blueprint lleva empresa, departamentos, roles, políticas, servidores MCP y
herramientas built-in — **sin credenciales**, y las tools de MCP se redescubren
al conectar. Lo que **no** lleva: corridas, entregables ni memoria.

Es un JSON: versionalo en git.

## Enlaces

- [[Persistencia y esquema SQL]]
- [[Comandos]]
- [[Empresas de ejemplo]]
