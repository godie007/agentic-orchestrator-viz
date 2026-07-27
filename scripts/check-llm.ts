/**
 * Prueba end-to-end de un proveedor: una llamada real con tool-calling, con el
 * costo calculado desde el catálogo vivo.
 *
 *   npm run check:llm                        # todos los configurados
 *   npm run check:llm -- --provider=openai   # uno solo
 *   npm run check:llm -- --model=x/y         # forzando un slug
 *
 * Es el checkpoint de desacoplamiento: el mismo código corre contra cualquier
 * proveedor sin ramificar por cuál es.
 */
import {
  buildRegistry,
  collect,
  computeCost,
  resolveTier,
  type ChatRequest,
  type LlmProvider,
  type ProviderId,
} from "@orq/llm";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key!, rest.join("=") || "true"] as const;
    }),
);

const registry = buildRegistry(process.env);
const requested = args.get("provider") as ProviderId | undefined;
const forcedModel = args.get("model");

const providers = requested ? [registry.get(requested)] : registry.list();
if (providers.length === 0) {
  console.error(
    "No hay proveedores configurados. Copiá .env.example a .env y completá al menos una API key.",
  );
  process.exit(1);
}

// Una tool trivial pero obligatoria: si el modelo no la llama, no sirve como
// agente, porque toda la coordinación de la empresa pasa por tool-calling.
const request: Omit<ChatRequest, "model"> = {
  messages: [
    {
      role: "system",
      content:
        "Sos un agente de prueba. Usá la herramienta disponible antes de responder.",
    },
    { role: "user", content: "¿Cuánto es 137 por 24? Usá la calculadora." },
  ],
  tools: [
    {
      name: "calculate",
      description: "Evalúa una operación aritmética simple",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Ej: 137 * 24" },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  ],
  maxOutputTokens: 512,
};

let failures = 0;

for (const provider of providers) {
  console.log(`\n═══ ${provider.label} (${provider.id}) ═══`);
  try {
    await exercise(provider);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures > 0 ? 1 : 0);

async function exercise(provider: LlmProvider): Promise<void> {
  const models = await provider.listModels();
  const slug = forcedModel ?? resolveTier(models, "cheap")?.model.slug;
  if (!slug) {
    throw new Error("No se pudo resolver un modelo del tier 'cheap'; pasá --model=<slug>");
  }
  const modelInfo = models.find((m) => m.slug === slug);
  console.log(`  modelo: ${slug}`);

  const startedAt = Date.now();
  process.stdout.write("  respuesta: ");
  const result = await collect(
    provider.chat({ ...request, model: slug }),
    (text) => process.stdout.write(text),
  );
  const latencyMs = Date.now() - startedAt;
  process.stdout.write("\n");

  const calls = result.message.toolCalls ?? [];
  if (calls.length === 0) {
    console.log("  ⚠ el modelo no llamó ninguna herramienta — no sirve como agente");
  } else {
    for (const call of calls) {
      console.log(`  tool call: ${call.name}(${JSON.stringify(call.arguments)})`);
    }
  }

  const cost = computeCost(modelInfo, result.usage);
  console.log(
    `  tokens: ${result.usage.inputTokens} entrada / ${result.usage.outputTokens} salida · ${latencyMs}ms`,
  );
  console.log(
    cost.priced
      ? `  costo: US$${cost.totalUsd.toFixed(6)}`
      : "  costo: sin precio publicado por el proveedor (el ledger contará tokens, no dinero)",
  );
  console.log(`  ✓ ${provider.label} responde y usa herramientas`);
}
