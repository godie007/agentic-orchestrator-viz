---
tags: [referencia]
aliases: [Esquemas, Zod, Tipos]
---

# Referencia de esquemas

`packages/shared/src/schema.ts`. El significado de cada entidad está en
[[Modelo de dominio]]; acá están los campos y sus restricciones.

## Primitivos

| Esquema | Restricción |
|---|---|
| `idSchema` | string, 1–64 |
| `timestampSchema` | entero no negativo (ms) |
| `providerIdSchema` | `openrouter`\|`anthropic`\|`openai`\|`ollama`\|`nvidia` |
| `modelTierSchema` | `free`\|`cheap`\|`standard`\|`smart` |

## `ModelSelection`

| Campo | Tipo | Default |
|---|---|---|
| `providerId` | `ProviderId` | — |
| `modelSlug` | `string \| null` | `null` — **tiene prioridad sobre `tier`** |
| `tier` | `ModelTier` | `"standard"` |
| `temperature` | `0–2 \| null` | `null` (default del proveedor) |
| `maxOutputTokens` | entero positivo | `4096` |

## `Company`

| Campo | Restricción | Default |
|---|---|---|
| `name` | 1–200 | — |
| `mission` | ≤ 4000 | `""` |
| `voz` | `Voz` | `{ unaSolaVoz: false, pronunciacion: {} }` |
| `context` | ≤ 20000 | `""` |
| `currency` | exactamente 3 | `"USD"` |
| `budgetUsd` | positivo | `1` |
| `defaultModel` | `ModelSelection` | — |

### `Voz`
`unaSolaVoz: boolean` · `pronunciacion: Record<string, string>` — lo escrito → cómo
se dice, **por palabra entera**.

## `Department`
`name` (1–200) · `purpose` (≤4000) · `parentId` (`null` = reporta a la empresa) ·
`position` (`{x,y}`, sólo presentación).

## `Role`

| Campo | Restricción | Default |
|---|---|---|
| `name` · `title` | 1–200 | — |
| `systemPrompt` | ≤ 20000 | `""` |
| `model` | `ModelSelection` | — |
| `toolIds` | `string[]` | `[]` |
| `authority` | `executor`\|`manager`\|`executive` | `"executor"` |
| `reportsTo` | `string \| null` | `null` |
| `maxTurns` | 1–50 | `8` |
| `spendApprovalThresholdUsd` | ≥ 0 \| `null` | `null` |

## `Policy`
`statement` (1–4000) · `appliesToRoleIds` (vacío = toda la empresa) ·
`gate: { type: "spend_above", amountUsd, requiresRoleId } | null`.

## `Programacion` (unión discriminada)

| `type` | Campos |
|---|---|
| `intervalo` | `cada` (entero positivo), `unidad`: `minutos`\|`horas`\|`dias`\|`semanas` |
| `semanal` | `dias` (0–6, **mín. 1**, 0 = domingo), `hora` (0–23), `minuto` (0–59) |
| `cron` | `expresion` (5 campos: minuto hora día-del-mes mes día-de-semana) |

## `Mision`
`name` (1–200) · `objective` (1–8000) · `programacion` · `enabled` (`true`) ·
`budgetUsd` (`1`) · `maxTicks` (`null`) · `avisarA` (emails, `[]`) ·
`proximaAt` · `ultimaAt` · `ultimaRunId`.

## `Tool`

| Campo | Restricción |
|---|---|
| `name` | 1–128. Las MCP usan `mcp__<servidor>__<tool>` |
| `origin` | `coordination`\|`capability`\|`skill`\|`mcp` |
| `description` | ≤ 2000 |
| `inputSchema` | JSON Schema, tal como se le pasa al modelo |
| `mcpServerId` · `requiresApproval` · `readOnly` | |

## `McpServer`
`name` — 1–64, **regex `^[a-z0-9_-]+$`** · `description` (≤1000) · `transport` ·
`enabled` (`true`) · `autoApproveTools` (`true`).

### `McpTransport`
| `type` | Campos |
|---|---|
| `stdio` | `command`, `args`, `envRefs`, `cwd` |
| `http` | `url`, `headerRefs`, `caPath` |

`envRefs` / `headerRefs`: **nombre** de la variable de entorno, nunca el valor.

## `Run`
`objective` (1–8000) · `status` (8 valores) · `mode` (`manual`\|`continuous`\|`cron`) ·
`tick` · `maxTicks` (`50`) · `budgetUsd` · `spentUsd` · `cronIntervalMs`
(`60000`) · `stopReason`.

## `Message`
`type` (9 valores) · `subject` (≤300) · `body` (**≤ 50000**) · `threadId` ·
`inReplyTo` · `status` (`pending`\|`delivered`\|`read`\|`answered`) · `tick`.

`fromRoleId: null` = la persona. `toRoleId: null` con `broadcast` (usa
`toDepartmentId`).

## `Task`
`title` (1–300) · `detail` (≤10000) · `status` (6 valores) · `priority`
(`low`\|`normal`\|`high`\|`urgent`) · `dueTick` · `result` (≤20000).

## `Artifact`
`key` (1–200) · `title` (1–300) · `contentType` (`markdown`\|`json`\|`text`) ·
`content` (**≤ 500000**) · `version` (positivo) · `authorRoleId` · `tick`.

## `ApprovalRequest`
`requestedByRoleId` · `approverRoleId` (`null` = decide la persona) ·
`reason` (≤4000) · `toolName` · `toolArgs` ·
`status` (`pending`\|`granted`\|`denied`\|`expired`) · `resolution` (≤4000).

## `AgentRequest`
`type` (`create_role`\|`context`\|`tool_access`) · `reason` (1–4000) ·
`roleProposal` · `question` (≤4000) · `toolNames` ·
`status` (`pending`\|`approved`\|`rejected`) · `resolution` (≤8000).

### `RoleProposal`
`name` · `title` · `departmentName` (si no existe, se crea al aceptar) ·
`systemPrompt` · `authority` · `reportsToName` (`null` = a quien lo propuso).

## `Learning`
`topic` (1–120) · `lesson` (1–4000) · `authorRoleId` (`null` = una persona) ·
`runId` · `timesConfirmed` (positivo).

## `LedgerEntry`
`providerId` · `modelSlug` · `tick` · `inputTokens` · `outputTokens` ·
`cachedInputTokens` · `costUsd` · `latencyMs`.

## `CompanyBlueprint`
`version: 1` · `company` · `departments` · `roles` · `policies` · `mcpServers` ·
`tools` (**sólo built-in**; las de MCP se redescubren al conectar).

## Payloads de la API

| Esquema | Campos |
|---|---|
| `createRunSchema` | `companyId`, `objective` (1–8000), `mode`, `maxTicks?` (≤500), `budgetUsd?` (≤1000), `cronIntervalMs?` (≥1000) |
| `injectMessageSchema` | `toRoleId`, `subject` (≤300), `body` (1–50000) |
| `resolveApprovalSchema` | `decision`: `grant`\|`deny`, `resolution` (≤4000) |
| `modelInfoSchema` | `providerId`, `slug`, `name`, `contextLength`, `inputPricePerMTok`, `outputPricePerMTok`, `supportsTools` |

## Enlaces

- [[Modelo de dominio]] — qué significa cada uno
- [[Referencia de API]]
- [[ADR-002 Zod como única fuente de verdad]]
