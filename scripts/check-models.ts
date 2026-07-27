/**
 * Muestra los modelos que cada tier resuelve contra el catálogo vivo, con su
 * precio real. Sirve para confirmar que la selección automática está eligiendo
 * algo razonable antes de darle trabajo a la empresa.
 *
 *   npm run check:models
 */
import { buildRegistry, resolveAllTiers } from "@orq/llm";

const registry = buildRegistry(process.env);
const providers = registry.list();

if (providers.length === 0) {
  console.error(
    "No hay proveedores configurados. Copiá .env.example a .env y completá al menos una API key.",
  );
  process.exit(1);
}

for (const provider of providers) {
  console.log(`\n═══ ${provider.label} (${provider.id}) ═══`);

  const health = await provider.healthCheck();
  if (!health.ok) {
    console.log(`  ✗ ${health.detail}`);
    continue;
  }
  console.log(`  ✓ ${health.detail}`);

  const models = await provider.listModels();
  const tiers = resolveAllTiers(models);

  for (const [tier, resolution] of Object.entries(tiers)) {
    if (!resolution) {
      console.log(`\n  ${tier.padEnd(9)} → sin candidatos (elegí un modelo explícito por rol)`);
      continue;
    }
    const { model, blendedPriceUsdPerMTok, reason } = resolution;
    console.log(`\n  ${tier.padEnd(9)} → ${model.slug}`);
    console.log(`    ${model.name}`);
    console.log(
      `    entrada US$${fmt(model.inputPricePerMTok)}/MTok · salida US$${fmt(model.outputPricePerMTok)}/MTok · mezclado US$${blendedPriceUsdPerMTok.toFixed(3)}/MTok`,
    );
    console.log(`    ${reason}`);
  }
}

function fmt(value: number | null): string {
  return value == null ? "s/d" : value.toFixed(3);
}
