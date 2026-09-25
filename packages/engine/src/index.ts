export * from "./events.js";
export * from "./state.js";
export * from "./loop.js";
export * from "./dificultad.js";
export * from "./scheduler.js";
export { buildSystemPrompt, buildTurnPrompt } from "./prompt.js";
// El arnés de tests se exporta a propósito: los tests del servidor guionan
// corridas reales con él, y sin export cada workspace copiaba el suyo.
export { FakeProvider, actorOf, alreadyActed } from "./testing/fake-provider.js";
