---
tags: [operación, referencia]
aliases: [.env, Configuración, Env]
---

# Variables de entorno

`.env` en la raíz, **git-ignored**. La plantilla es `.env.example`.

> [!info] Se valida una sola vez, al arrancar
> `apps/server/src/env.ts` → `loadEnv`. Un valor mal puesto falla ahí y no en
> medio de una corrida. Los numéricos tienen que ser **positivos**.

## Proveedores LLM

Configurá al menos uno.

| Variable | Por defecto | Notas |
|---|---|---|
| `OPENROUTER_API_KEY` | — | cientos de modelos con una sola key |
| `ANTHROPIC_API_KEY` | — | directo |
| `OPENAI_API_KEY` | — | directo |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | local, costo cero. Vacío desactiva el proveedor |
| `NVIDIA_API_KEY` | — | build.nvidia.com, sin costo con límite de tasa |
| `ORQ_CLAUDE_SESION` | — | prende **Claude (sesión)** como proveedor aparte. Es un interruptor (`1` / `true` / `si`), no una credencial |
| `ANTHROPIC_AUTH_TOKEN` | — | token OAuth de `ant auth print-credentials --access-token`. **De corta vida**: cuando venza, volvé a exportarlo |
| `ORQ_CLAUDE_CODE` | `1` | prende **Claude Code (suscripción)**: delega al CLI oficial, que corre con tu plan Pro/Max y **no factura uso**. Exige `claude` instalado y logueado |
| `CLAUDE_CODE_MODEL` | `sonnet` | alias del CLI (`haiku` / `sonnet` / `opus`) |
| `CLAUDE_CODE_WORKDIR` | `./data/claude-code` | carpeta donde el agente deja sus archivos (se crea sola) |
| `ORQ_SOCKET` | (interno) | ruta del socket Unix que usa el puente MCP del org para el turno `claude-code`. La fija el engine por turno; no se configura |

> [!danger] La variable `ANTHROPIC_MODEL` desvía a facturación por uso
> Exportarla en el shell (`export ANTHROPIC_MODEL="claude-haiku-4-5-…"`) fuerza
> al CLI a un modelo de **billing por créditos** en vez de tu suscripción, y le
> fija el modelo ignorando el de `settings.json`. Para usar el plan Pro/Max con
> `claude-code`, esa variable debe estar **ausente** del entorno.

> [!danger] Una `ANTHROPIC_API_KEY` vacía pisa la sesión
> Gana su lugar en la cadena de credenciales del SDK aunque no tenga valor, y
> autentica con una clave en blanco → 401 sin explicación. `.env.example` la trae
> vacía. Al prender `ORQ_CLAUDE_SESION`, el orquestador la saca del entorno.
> Ver [[Capa LLM y tiers]].

## Servidor

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3001` | |
| `DATABASE_URL` | `./data/orquestador.db` | relativo a la **raíz del monorepo**, no al cwd |
| `EXPORTS_DIR` | `./data/exports` | dónde van Word, PDF, video, deck |
| `MUSICA_DIR` | `./data/musica` | las pistas. Si no existe, los videos salen sin música |

> Las rutas relativas se anclan a la raíz del monorepo (`fromRoot`), para que la
> base sea la misma tanto si arrancás desde la raíz como desde el workspace.

## Límites de seguridad

| Variable | Por defecto | Para qué |
|---|---|---|
| `DEFAULT_RUN_BUDGET_USD` | `1.00` | tope de gasto por corrida. **Última red de contención**: configurá también un límite en el dashboard de tu proveedor |
| `DEFAULT_MAX_TICKS` | `50` | máximo de ciclos por corrida |
| `AGENT_CONCURRENCY` | `4` | turnos ejecutados en paralelo dentro de un tick |

Ver [[Costos y presupuesto]].

## Imágenes generadas

| Variable | Notas |
|---|---|
| `GOOGLE_API_KEY` | Gemini, centavos por imagen — **primera opción** |
| `OPENAI_API_KEY` | segunda |
| `NVIDIA_API_KEY` | FLUX, nivel gratuito — tercera |

Se usa el primer proveedor con credencial, en ese orden. **Sin ninguna,
`generar_imagen` no se registra** y los videos usan sólo las imágenes que ya
estén en el directorio de salida, avisando cuáles no se pudieron mostrar.

## Misiones y correo

| Variable | Por defecto | Para qué |
|---|---|---|
| `N8N_EMAIL_WEBHOOK_URL` | — | el flujo que despacha el correo. Sin esto, las misiones corren pero no avisan |
| `API_URL` | `http://localhost:<PORT>` | base pública de la API, para los enlaces de descarga de los avisos |
| `APP_URL` | `http://localhost:5173` | a dónde apuntan los enlaces a la UI. También se usa para atribución en OpenRouter |
| `MISION_TICK_MS` | `30000` | cada cuánto se revisa si a alguna misión le toca correr |

Ver [[Correo y avisos]] y [[Misiones programadas]].

## Atribución en OpenRouter (opcional)

`APP_URL` y `APP_TITLE` aparecen en el ranking público de OpenRouter. Sin efecto
funcional.

## Otras

| Variable | Para qué |
|---|---|
| `ORQ_KOKORO_HOME` | dónde está el modelo de voz. Si no, se busca en `~/.cache/`; sin él, respaldo `say` de macOS |
| `ORQ_SEED_TIER` | tier con el que siembra `npm run db:estudio` (por defecto `free`) |

## Lo que NO va en `.env`

**Los secretos de los servidores MCP.** Van en la configuración de la empresa
**por referencia**: el nombre de la variable de entorno, nunca el valor. La
variable en sí sí puede estar en `.env` — lo que no se guarda es su valor en la
base ni en el blueprint exportado. Ver [[Seguridad]].

## Rotar credenciales

> Si alguna vez pegaste una API key en un chat, **rotala**: quedó en el historial
> de esa conversación. La nueva va en `.env`, que está git-ignored.

## Enlaces

- [[Instalación y arranque]]
- [[Seguridad]]
- [[Diagnóstico de problemas]]
