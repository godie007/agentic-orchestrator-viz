---
tags: [referencia]
aliases: [Eventos, TraceEvent]
---

# Referencia de eventos

`packages/shared/src/events.ts`. Unión discriminada por `type`, con el helper
`isEvent(event, "tipo")` para estrecharla. El uso está en
[[Observabilidad y trazas]].

## Campos comunes

Todos los eventos llevan:

```ts
{ id: string, runId: string, tick: number, at: number }
```

`TraceEventInput` es el mismo evento **sin `id` ni `at`**: los rellena el emisor.

---

## `run.status`
| Campo | Tipo |
|---|---|
| `status` | `idle`\|`running`\|`paused`\|`awaiting_approval`\|`completed`\|`stopped`\|`budget_exceeded`\|`failed` |
| `reason` | `string \| null` |

## `tick.start`
| Campo | Tipo | Notas |
|---|---|---|
| `activeRoleIds` | `string[]` | los roles que van a ejecutar turno en este tick |

## `tick.end`
| Campo | Tipo |
|---|---|
| `messagesEmitted` | `number` |
| `costUsd` | `number` |

---

## `agent.thinking`
| Campo | Tipo | Notas |
|---|---|---|
| `roleId` | `string` | **el nodo del organigrama empieza a pulsar** |
| `providerId` · `modelSlug` | `string` | |
| `iteration` | `number` | vuelta dentro del turno |

## `agent.turn_end`
| Campo | Tipo | Notas |
|---|---|---|
| `roleId` | `string` | |
| `iterations` | `number` | |
| `costUsd` | `number` | |
| `summary` | `string \| null` | texto final del turno, si escribió algo |

> [!danger] Se emite en `finally`
> Si un turno falla y no lo emite, el nodo queda "pensando…" para siempre.

## `agent.message`
| Campo | Tipo | Notas |
|---|---|---|
| `messageId` | `string` | |
| `fromRoleId` | `string \| null` | `null` = la persona |
| `toRoleId` | `string \| null` | `null` con broadcast |
| `toDepartmentId` | `string \| null` | |
| `messageType` | los 9 de `MessageType` | |
| `subject` · `preview` | `string` (preview ≤ 500) | **un paquete viaja por la arista** |

---

## `tool.selection`
| Campo | Tipo | Notas |
|---|---|---|
| `roleId` | `string` | |
| `candidates` | `string[]` | todas las que el rol tiene permitidas |
| `exposed` | `string[]` | las que efectivamente se le pasaron al modelo |
| `strategy` | `"all"` \| `"ranked"` | |
| `reason` | `string` | el motivo, legible |

Se emite **antes** de la llamada al modelo. Ver
[[Herramientas y tool router]].

## `tool.start`
| Campo | Tipo |
|---|---|
| `roleId` · `callId` · `toolName` | `string` |
| `origin` | `coordination`\|`capability`\|`skill`\|`mcp` |
| `mcpServerId` | `string \| null` |
| `args` | `Record<string, unknown>` |

## `tool.end`
| Campo | Tipo | Notas |
|---|---|---|
| `roleId` · `callId` · `toolName` · `origin` · `mcpServerId` | ídem | |
| `durationMs` | `number` | |
| `ok` | `boolean` | |
| `preview` | `string` (≤ 2000) | recorte del resultado, para no volcar todo el payload |
| `error` | `string \| null` | |

---

## `mcp.status`
| Campo | Tipo |
|---|---|
| `serverId` · `serverName` | `string` |
| `status` | `disabled`\|`connecting`\|`ready`\|`error`\|`reconnecting` |
| `toolCount` | `number` |
| `handshakeMs` | `number \| null` |
| `error` | `string \| null` |

Va por el canal SSE **global**.

---

## `task.changed`
| Campo | Tipo | Notas |
|---|---|---|
| `taskId` · `title` · `assigneeRoleId` | `string` | |
| `status` | los 6 de `TaskStatus` | |
| `created` | `boolean` | `true` sólo en la creación, para animarla distinto |

## `artifact.created`
| Campo | Tipo |
|---|---|
| `artifactId` · `key` · `title` · `authorRoleId` | `string` |
| `version` | `number` |

## `request.created`
| Campo | Tipo |
|---|---|
| `requestId` | `string` |
| `requestedByRoleId` | `string \| null` |
| `requestType` | `create_role`\|`context`\|`tool_access` |
| `reason` · `summary` | `string` |

## `approval.changed`
| Campo | Tipo |
|---|---|
| `approvalId` · `requestedByRoleId` | `string` |
| `approverRoleId` | `string \| null` |
| `status` | `pending`\|`granted`\|`denied`\|`expired` |
| `reason` | `string` |
| `toolName` | `string \| null` |

---

## `cost.updated`
| Campo | Tipo |
|---|---|
| `roleId` | `string \| null` |
| `providerId` · `modelSlug` | `string` |
| `deltaUsd` · `totalUsd` · `budgetUsd` | `number` |
| `inputTokens` · `outputTokens` · `cachedInputTokens` | `number` |

## `log`
| Campo | Tipo |
|---|---|
| `level` | `debug`\|`info`\|`warn`\|`error` |
| `message` | `string` |
| `roleId` | `string \| null` |

---

## Agregar una variante

Ver [[Cómo agregar un evento]]. En corto: la variante entra en `events.ts`
primero, se agrega a `traceEventSchema`, y recién ahí el motor la puede emitir.

**Un paso que no emite evento es un paso invisible.**
