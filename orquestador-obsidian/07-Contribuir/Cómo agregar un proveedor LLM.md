---
tags: [contribuir]
aliases: [Nuevo proveedor, Adaptador LLM]
---

# Cómo agregar un proveedor LLM

Es un archivo nuevo en `packages/llm/src/adapters/` y tres líneas más. El motor
no se toca.

## 1. El `providerId`

`packages/shared/src/schema.ts`:

```ts
export const providerIdSchema = z.enum([
  "openrouter", "anthropic", "openai", "ollama", "nvidia",
  "mi-proveedor",   // ←
]);
```

Zod primero, siempre. Ver [[ADR-002 Zod como única fuente de verdad]].

## 2. El adaptador

`packages/llm/src/adapters/mi-proveedor.ts`. Implementa `LlmProvider`
(`packages/llm/src/types.ts`) traduciendo **en su borde** entre el formato de
mensajes neutro del proyecto y el del proveedor.

Lo que tiene que resolver:

| Responsabilidad | Notas |
|---|---|
| **chat con tool-calling** | es el requisito duro: un modelo sin tool-calling no sirve para un agente |
| **catálogo de modelos** | `ModelInfo[]` con `contextLength`, precios por MTok y `supportsTools`. Es lo que consume la resolución de tiers |
| **costo** | informarlo si el proveedor lo informa; si no, se estima con el precio del catálogo |
| **tokens cacheados** | `cachedInputTokens`, si el proveedor los reporta |
| **corte por tiempo** | obligatorio. Ver [[Invariantes de arquitectura]] §13 |
| **errores tipados** | `LlmError`, para que el loop pueda reintentar con backoff |

> [!tip] Si el proveedor habla formato OpenAI
> Reusá `adapters/openai-shared.ts`. Es lo que hacen `openai.ts`, `nvidia.ts` y
> parte de `ollama.ts`.

### Precios

Si el proveedor **no publica precios**, devolvé `null` en
`inputPricePerMTok` / `outputPricePerMTok`. Un modelo sin precio queda fuera de la
resolución por tier (`blendedPrice` devuelve `null`) y sólo se puede usar fijando
el `modelSlug` exacto. Es el comportamiento correcto: mejor inalcanzable por tier
que elegido a ciegas.

## 3. Exportarlo

`packages/llm/src/index.ts`:

```ts
export { MiProveedor, type MiProveedorConfig } from "./adapters/mi-proveedor.js";
```

## 4. Registrarlo

`packages/llm/src/registry.ts`: que se construya cuando su credencial está
presente, y **que no se construya cuando no lo está** — un proveedor sin
credencial no debe aparecer como disponible.

> [!warning] `ANTHROPIC_API_KEY` sin definir **no** significa que no haya credencial
> Los SDK de Anthropic resuelven en cadena: `ANTHROPIC_API_KEY` →
> `ANTHROPIC_AUTH_TOKEN` → el perfil OAuth activo de `ant auth login` →
> Workload Identity Federation → el perfil por defecto en disco. Un
> `new Anthropic()` sin argumentos funciona después de `ant auth login`, sin
> ninguna variable de entorno.
>
> Consecuencia para el registro: si mirás sólo `process.env.ANTHROPIC_API_KEY`
> para decidir si el proveedor está disponible, lo vas a ocultar en una máquina
> que sí puede llamar a la API. Es el camino para correr el orquestador **con tu
> propio login en desarrollo**; para un servidor, el camino soportado sigue
> siendo la API key o WIF. Ver [[ADR-001 No usar Claude Agent SDK]].

## 5. La variable de entorno

`.env.example` + [[Variables de entorno]]. Documentá qué pasa si falta.

## 6. Verificar

```bash
npm run check:models                      # ¿resuelve los cuatro tiers?
npm run check:llm                         # ¿contesta con tool-calling?
npm run check:llm -- --model=<slug>       # uno puntual
npm run typecheck && npm test
```

`check:llm` hace una llamada **real**: es la prueba que importa.

## Lista de control

- [ ] `providerIdSchema` actualizado
- [ ] tool-calling funcionando (verificado con `check:llm`, no supuesto)
- [ ] catálogo con `contextLength`, precios y `supportsTools`
- [ ] corte por tiempo
- [ ] errores como `LlmError` para que el backoff funcione
- [ ] costo informado o estimable
- [ ] sin credencial, el proveedor **no aparece**
- [ ] `.env.example` y la bóveda actualizados

## Nota sobre un proveedor "suscripción Claude"

Es exactamente este procedimiento. Ver
[[ADR-001 No usar Claude Agent SDK]] para el contexto legal y de producto por el
que hoy no existe.

## Enlaces

- [[Capa LLM y tiers]]
- [[Costos y presupuesto]]
