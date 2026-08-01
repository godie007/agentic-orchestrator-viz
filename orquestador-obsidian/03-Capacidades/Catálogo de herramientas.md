---
tags: [capacidad, referencia]
aliases: [Herramientas, Tools]
---

# Catálogo de herramientas

Todas las herramientas que un agente puede invocar por function-calling.
El mecanismo está en [[Herramientas y tool router]].

> [!info] Dos reglas de asignación opuestas
> Las de **coordinación se otorgan siempre**, sin mirar `role.toolIds`.
> Las de **capacidad, habilidad y MCP** dependen de `toolIds`.

---

## Origen `coordination` — se otorgan siempre

`packages/tools/src/coordination.ts` → `coordinationTools`

### Cálculo y búsqueda

| Herramienta | Qué hace |
|---|---|
| `calcular` | hace una cuenta bien. No coordina a nadie, pero va acá porque **hacer una cuenta no es una capacidad especial que haya que asignar rol por rol, es higiene**: un rol nuevo la tiene desde el primer turno sin que nadie se acuerde de dársela |
| `verificar_cifras` | contrasta las cifras de un texto contra su cálculo |
| `buscar_en_entregables` | busca dentro de los entregables sin traerse el documento entero al contexto |

### Mensajería

| Herramienta | Qué hace |
|---|---|
| `send_message` | escribirle a otro rol. **Rechaza escribirle de nuevo a quien todavía no contestó** |
| `reply` | contestar el mensaje pendiente del turno |
| `broadcast` | a todo un departamento |
| `escalate` | subir en la jerarquía, a `reportsTo` |

### Trabajo

| Herramienta | Qué hace |
|---|---|
| `assign_task` | asignar una tarea. **Valida la jerarquía en código**: un ejecutor que intenta asignarle a su jefe recibe el error y la lista de su equipo real |
| `update_task` | cambiar estado, prioridad o resultado |
| `list_my_tasks` | las propias |
| `request_approval` | pedir permiso a quien tiene autoridad |

### Entregables

| Herramienta | Qué hace |
|---|---|
| `write_artifact` | crear o versionar un entregable. Pasa por `revisarCalidad` |
| `edit_artifact` | modificar uno existente sin reescribirlo entero |
| `read_artifact` | leerlo. Una relectura devuelve **un puntero**, no el contenido |
| `list_artifacts` | los de la empresa, marcando los que vienen de otra corrida |

### Auditoría y memoria

| Herramienta | Qué hace |
|---|---|
| `check_activity` | qué herramienta ejecutó cada agente y con qué resultado real, filtrable por rol. Últimas 500 entradas |
| `record_lesson` | registrar un aprendizaje a nivel empresa |

### Pedirle algo a la persona

| Herramienta | Qué hace |
|---|---|
| `request_new_role` | "necesito a alguien que se ocupe de X", con una propuesta de rol editable |
| `request_context` | "necesito saber Y del negocio" |
| `request_tool_access` | "necesito la herramienta Z" |

Ver [[Coordinación entre agentes]].

---

## Origen `capability` — se asignan

`packages/tools/src/capability.ts` → `capabilityTools`

| Herramienta | Qué hace |
|---|---|
| `web_search` | búsqueda web |
| `fetch_url` | traer una URL. **Bloquea loopback, rangos privados y link-local**, para que un prompt no pueda usar a un agente para escanear la red interna del host |

---

## Origen `skill` — se asignan

`packages/tools/src/skills/index.ts` → `createSkillTools(storage, opciones)`

Reciben **la clave de un entregable ya escrito**, nunca el contenido. Ver
[[ADR-005 Las habilidades trabajan sobre entregables ya escritos]].

| Herramienta | Qué produce | Condición |
|---|---|---|
| `export_docx` | Word con portada, encabezado, pie numerado, tablas con bordes | siempre |
| `export_pdf` | PDF, mismo contenido y maquetación | siempre |
| `export_video` | `.mp4` narrado, con música, íconos, visuales e imágenes | siempre |
| `export_slides` | deck `.html` autocontenido, sin pedidos a la red | siempre |
| `generar_imagen` | una imagen a partir de una descripción | **sólo si hay API key de imágenes** |
| `write_output_file` | crear o reemplazar un archivo de texto en el directorio de salida | siempre |
| `list_output` | el árbol del directorio de salida | siempre |
| `delete_files` | borrar; acepta `kind` para un grupo entero | siempre, sujeto a `puedeBorrar` |

> [!important] La que no se puede cumplir, no se registra
> Ofrecerle al agente una herramienta que siempre falla le hace gastar turnos
> intentándola. Por eso `generar_imagen` no aparece sin credencial.

Ver [[Habilidades de producción]] y [[Producción audiovisual]].

---

## Correo

`packages/tools/src/correo.ts` → `createEmailTools`

| Herramienta | Qué hace |
|---|---|
| `send_email` | despacha por el webhook de n8n. Sin `N8N_EMAIL_WEBHOOK_URL` **falla diciendo exactamente qué falta y de quién es el problema** |

Ver [[Correo y avisos]].

---

## Origen `mcp` — se descubren

Nombradas `mcp__<servidor>__<tool>`. Ver [[Integración MCP]].

---

## Contrato

```ts
{ name, origin, description, inputSchema, mcpServerId, requiresApproval, readOnly }
```

- `readOnly: true` → el motor puede ejecutarlas en paralelo.
- `requiresApproval: true` → **no se ejecuta**: abre una aprobación y detiene esa
  rama del trabajo.

Ver [[Referencia de herramientas]] para los argumentos, y
[[Cómo agregar una herramienta]] para extender el catálogo.
