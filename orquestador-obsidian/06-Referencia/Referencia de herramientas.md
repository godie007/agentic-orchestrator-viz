---
tags: [referencia]
aliases: [Herramientas detalle, Tools referencia]
---

# Referencia de herramientas

Detalle operativo. La visión general está en [[Catálogo de herramientas]]; el
mecanismo, en [[Herramientas y tool router]].

## Coordinación (`packages/tools/src/coordination.ts`)

Se otorgan **siempre**, sin mirar `role.toolIds`.

| Herramienta | Argumentos principales | Guardias |
|---|---|---|
| `calcular` | la expresión | — |
| `verificar_cifras` | el texto a contrastar | — |
| `buscar_en_entregables` | el término | devuelve bloques, no el documento entero |
| `send_message` | destinatario, asunto, cuerpo, tipo | **rechaza escribirle de nuevo a quien no contestó** |
| `reply` | cuerpo | responde el mensaje pendiente del turno, incluido el de tipo `human` |
| `broadcast` | departamento, asunto, cuerpo | |
| `escalate` | motivo | va a `reportsTo` |
| `assign_task` | responsable, título, detalle, prioridad | **valida la jerarquía**; el error incluye la lista del equipo real |
| `update_task` | id, estado, resultado | |
| `list_my_tasks` | — | |
| `request_approval` | motivo, aprobador | |
| `write_artifact` | `key`, `title`, `content` | `revisarCalidad` + guardia de claves-variante |
| `edit_artifact` | `key` + el cambio | evita reescribir el documento entero |
| `read_artifact` | `key` | una relectura devuelve **un puntero** |
| `list_artifacts` | — | marca los que vienen de otra corrida |
| `check_activity` | `roleId?` | últimas 500 entradas |
| `record_lesson` | `topic`, `lesson` | deduplica por tema y texto normalizado |
| `request_new_role` | `roleProposal`, motivo | va a la bandeja de la persona |
| `request_context` | pregunta, motivo | ídem |
| `request_tool_access` | nombres de tools, motivo | ídem |

### Las guardias de `write_artifact`

**`revisarCalidad`** rechaza:
- títulos sobre el proceso interno: "Ciclo 2", "Bandeja de entrada";
- más de 400 caracteres sin una sola sección.

**Claves-variante** rechazadas, con pedido de versionar la original:
`-ciclo3`, `_v2`, `-final`, y sufijos colgados como `-detalle`.

## Capacidad (`packages/tools/src/capability.ts`)

| Herramienta | Notas |
|---|---|
| `web_search` | constante `WEB_SEARCH_TOOL_NAME` |
| `fetch_url` | **bloquea loopback, rangos privados y link-local** (`isPrivateHost`) |

## Habilidades (`packages/tools/src/skills/index.ts`)

Registradas por `createSkillTools(storage, opciones)`. Todas reciben la **clave**
de un entregable, no su contenido.

| Herramienta | Argumentos | Salida |
|---|---|---|
| `export_docx` | `key`, `folder?` | `key.docx` |
| `export_pdf` | `key`, `folder?` | `key.pdf` |
| `export_video` | `key`, `folder?` | `key.mp4` |
| `export_slides` | `key`, `folder?` | `key.html` — autocontenido, imágenes como `data:` |
| `generar_imagen` | descripción | en `imagenes/`, con nombre derivado del prompt. **Sólo se registra si hay credencial** |
| `write_output_file` | `path`, `content` | crea o reemplaza un archivo de texto |
| `list_output` | — | el árbol, sin los archivos que empiezan con punto |
| `delete_files` | rutas, o `kind`: `multimedia`\|`documents`\|`all`, `folder?` | sujeto a `puedeBorrar` y a procedencia |

`FORMATOS` en `skills/index.ts` define los dos documentos:
`docx → renderDocx`, `pdf → renderPdf`.

### `SkillStorage` — lo que el servidor inyecta

```ts
save({ filename, folder?, bytes }) → { url, path, sizeBytes }
list() → Array<{ path, sizeBytes, esMultimedia, generadoPorAgente }>
remove(path) → { ok } | { ok: false, motivo }
removeMany({ kind, folder?, excluir? }) → { borrados, fallidos }
writeText(path, content) → { ok, path, sizeBytes } | { ok: false, motivo }
resolve(path) → string | null    // ruta absoluta saneada, para abrir una imagen
```

`resolve` existe para el video, que necesita **abrir** una imagen y no puede
recibirla como texto. Devuelve una ruta ya saneada: la propone un agente, así que
quien resuelve sigue siendo el servidor.

### `OpcionesHabilidades`

```ts
{ musicaHome?: string, generadorImagenes?: GeneradorImagenes | null }
```

`generadorImagenes: null` es una configuración **válida** — una empresa sin
proveedor de imágenes — y entonces el video se filma con lo que ya existe en el
directorio.

## Correo (`packages/tools/src/correo.ts`)

| Herramienta | Argumentos | Notas |
|---|---|---|
| `send_email` | `to`, `subject`, `text`, `attachments?` | sin `N8N_EMAIL_WEBHOOK_URL` falla diciendo qué falta |

## MCP

Nombradas `mcp__<servidor>__<tool>`, descubiertas al conectar. Ver
[[Integración MCP]].

## Contrato de una herramienta

```ts
interface RegisteredTool {
  name: string
  origin: "coordination" | "capability" | "skill" | "mcp"
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema
  mcpServerId: string | null
  requiresApproval: boolean
  readOnly: boolean
  execute(args, ctx: ToolContext): Promise<ToolResult>
}
```

Resultado con `ok(mensaje, ref?)` o `fail(motivo)`.

> [!important] El error importa tanto como el camino feliz
> Es lo único que el agente puede leer para corregirse. Un "no existe" a secas
> hace que reintente con la misma clave inventada.

## Enlaces

- [[Catálogo de herramientas]]
- [[Cómo agregar una herramienta]]
- [[Habilidades de producción]]
