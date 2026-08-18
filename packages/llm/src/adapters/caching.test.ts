import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { splitSystem } from "./anthropic.js";
import { toOpenAiMessagesConCache } from "./openai-shared.js";

const conversacion: ChatMessage[] = [
  { role: "system", content: "Dirigís Codytion. Instrucciones largas y estables." },
  { role: "user", content: "Hacé la propuesta comercial." },
  { role: "assistant", content: "", toolCalls: [{ id: "tool_1", name: "escribir_entrega", arguments: { clave: "propuesta" } }] },
  { role: "tool", content: "Entregable escrito con 37 filas de mercado.", toolCallId: "tool_1" },
];

describe("typeof splitSystem marco los breakpoints de caché", () => {
  it("el system sale como un bloque con `cache_control`", () => {
    const { system } = splitSystem(conversacion);
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({
      type: "text",
      text: "Dirigís Codytion. Instrucciones largas y estables.",
      cache_control: { type: "ephemeral" },
    });
  });

  it("el último mensaje de la conversación lleva el breakpoint final", () => {
    const { messages } = splitSystem(conversacion);
    const ultimo = messages.at(-1)!;
    expect(ultimo.role).toBe("user");
    const contenido = ultimo.content as Array<{ type: string; cache_control?: unknown }>;
    const ultimoBloque = contenido.at(-1)!;
    expect(ultimoBloque).toMatchObject({
      type: "tool_result",
      cache_control: { type: "ephemeral" },
    });
    // Los bloques intermedios no llevan breakpoint: con dos resultados de una
    // sola pasada, ambos caen en el mismo `user` y sólo el último lo lleva.
    const dosResultados = splitSystem([
      { role: "system", content: "sistema" },
      { role: "user", content: "pregunta" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tool_1", name: "escribir_entrega", arguments: { clave: "propuesta" } },
          { id: "tool_2", name: "leer_archivo", arguments: { ruta: "x" } },
        ],
      },
      { role: "tool", content: "Primer resultado.", toolCallId: "tool_1" },
      { role: "tool", content: "Segundo resultado.", toolCallId: "tool_2" },
    ]);
    const agrupado = dosResultados.messages.at(-1)!.content as Array<{
      type: string;
      cache_control?: unknown;
    }>;
    expect(agrupado).toHaveLength(2);
    expect(agrupado[0]).not.toHaveProperty("cache_control");
    expect(agrupado.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  it("sin tool calls, el último mensaje de texto se convierte a bloque cacheado", () => {
    const { messages } = splitSystem([
      { role: "system", content: "sistema" },
      { role: "user", content: "pregunta" },
    ]);
    const ultimo = messages.at(-1)!;
    expect(ultimo).toEqual({
      role: "user",
      content: [
        { type: "text", text: "pregunta", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("no se tocan los mensajes con el role `assistant` del medio", () => {
    const { messages } = splitSystem(conversacion);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).not.toHaveProperty("cache_control");
  });
});

describe("toOpenAiMessagesConCache", () => {
  it("marca system y el último mensaje con cache_control", () => {
    const mensajes = toOpenAiMessagesConCache(conversacion);
    const [system, ...resto] = mensajes;
    expect(system?.content).toEqual([
      { type: "text", text: conversacion[0]!.content, cache_control: { type: "ephemeral" } },
    ]);
    const ultimo = resto.at(-1)!;
    expect(ultimo.content).toEqual([
      { type: "text", text: conversacion[3]!.content, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("los mensajes del medio conservan content plano (sin bloques)", () => {
    const mensajes = toOpenAiMessagesConCache(conversacion);
    expect(mensajes[1]).toEqual({ role: "user", content: "Hacé la propuesta comercial." });
    // El assistant conserva sus tool_calls y content plano.
    const assistant = mensajes[2]!;
    expect(assistant.content).toBeNull();
    expect(assistant).toHaveProperty("tool_calls");
  });
});