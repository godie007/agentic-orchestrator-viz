---
tags: [meta]
---

# Convenciones de documentación

## Idioma

Todo en **español rioplatense**, igual que el código, los comentarios y la UI.
Un párrafo en inglés desentona con todo lo que lo rodea. Los identificadores de
código se dejan como están (`write_artifact`, `RunState`, `tool.selection`): son
nombres, no palabras.

## Frontmatter

Cada nota abre con:

```yaml
---
tags: [categoría, subcategoría]
aliases: [otro nombre con el que la buscarías]
---
```

Etiquetas en uso: `moc`, `meta`, `producto`, `arquitectura`, `adr`,
`capacidad`, `caso-de-uso`, `operación`, `referencia`, `contribuir`.

## Enlaces

- Enlace interno con `[[Nombre exacto de la nota]]`. Sin rutas: Obsidian resuelve
  por nombre, así que mover una nota de carpeta no rompe nada.
- **No repitas lo que ya está en otra nota.** Enlazá. Si un concepto aparece en
  tres lugares, es señal de que merece su propia nota.
- Un `[[enlace]]` a una nota que todavía no existe es válido: marca algo que vale
  la pena escribir.

## Anclaje al código

Toda afirmación técnica nombra su fuente, con la ruta relativa a la raíz del
repositorio y, cuando ayuda, el símbolo:

> El tier se resuelve contra el catálogo vivo del proveedor
> (`packages/llm/src/tiers.ts` → `resolveTier`).

Sin ese anclaje, la documentación envejece en silencio. Con él, quien duda
verifica en diez segundos.

## Qué NO va en esta bóveda

- **Secretos.** Ninguna API key, ningún token, ningún valor de `.env`. Los
  ejemplos usan nombres de variable, nunca valores.
- **Datos de clientes reales.** Las empresas de ejemplo son ficticias.
- **Copias del código.** Un fragmento corto para ilustrar, sí; un archivo entero
  pegado, no: se desincroniza a la primera edición.
- **Historial de cambios.** Para eso está git.

## Diagramas

Mermaid, embebido en la nota. Obsidian los dibuja nativo y sobreviven a un
`grep`, cosa que una imagen no hace. Diagramas de secuencia para flujos,
`graph` para estructuras, `erDiagram` para el esquema de datos.

## Estilo

Frases cortas. La razón antes que la regla: "se hace así **porque** pasó esto".
Una decisión sin su costo no se puede revisar más adelante — por eso los
[[Decisiones de arquitectura|ADR]] siempre incluyen qué se resignó.
