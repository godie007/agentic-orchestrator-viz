---
tags: [contribuir]
aliases: [Nueva herramienta, Nueva habilidad]
---

# Cómo agregar una herramienta

Primero decidí el **origen**, porque cambia las reglas:

| Origen | Cuándo | Asignación |
|---|---|---|
| `coordination` | los agentes no podrían operar sin ella | **siempre otorgada** |
| `capability` | una capacidad general que no todos necesitan | por `toolIds` |
| `skill` | **produce un archivo** | por `toolIds` |
| `mcp` | viene de afuera | ver [[Integración MCP]] — no se programa acá |

> [!warning] El umbral para `coordination` es alto
> `calcular` está ahí porque **hacer una cuenta bien es higiene, no una capacidad
> especial**: un rol nuevo la tiene desde el primer turno sin que nadie se acuerde
> de dársela. Ese es el criterio, no "es útil".

---

## Una herramienta de capacidad o coordinación

### 1. Definirla

En `capability.ts` o `coordination.ts`:

```ts
const miTool: RegisteredTool = {
  name: "mi_tool",
  origin: "capability",
  description: "Qué hace, en una frase que el modelo entienda",
  inputSchema: {
    type: "object",
    properties: { texto: { type: "string", description: "…" } },
    required: ["texto"],
    additionalProperties: false,   // ← importa, ver abajo
  },
  mcpServerId: null,
  requiresApproval: false,
  readOnly: true,
  async execute(args, ctx) {
    // …
    return ok("qué pasó, en una frase");
  },
};
```

### 2. Agregarla al array exportado
`capabilityTools` o `coordinationTools`.

### 3. Un test
En `capability.test.ts` o `coordination.test.ts`. Probá **el error tanto como el
camino feliz**.

---

## Una habilidad (produce un archivo)

### 1. El render, aparte
Que reciba **bloques neutros** de `markdown.ts` o el `Guion` de `guion.ts`, no
markdown crudo. Así una corrección de parseo beneficia a todas las salidas y
ninguna puede decir algo distinto que las otras.

### 2. La herramienta
Recibe **la `key` de un entregable**, nunca el contenido. Ver
[[ADR-005 Las habilidades trabajan sobre entregables ya escritos]].

Usá `buscarEntregable`: cuando la clave no existe, **explica qué claves sí
existen**.

### 3. Registrarla en `createSkillTools`

```ts
return [
  ...(Object.keys(FORMATOS) as Formato[]).map((f) => crearSkill(f, storage)),
  crearVideo(storage, opciones),
  crearMiHabilidad(storage),        // ←
  // …
];
```

> [!important] La que no se puede cumplir, no se registra
> Si depende de una credencial o de un binario, **no la registres cuando falta**.
> Ofrecerle al agente una herramienta que siempre falla le hace gastar turnos
> intentándola. Es lo que hace `generar_imagen`.

### 4. No leas el disco desde `packages/tools`
Pedí lo que necesites por `SkillStorage` (`save`, `list`, `remove`, `writeText`,
`resolve`). El servidor es quien sanea rutas.

### 5. Registrarla en los seeds
En la tabla `tools` **y** en `role.toolIds`. Sin eso, el agente explica que no la
encuentra. Ver [[Invariantes de arquitectura]] §7.

---

## Reglas que valen para las tres

### El `inputSchema` cierra con `additionalProperties: false`

Es lo que permite que la huella del memo de lecturas se calcule **sólo sobre lo
declarado**. Sin eso, un argumento inventado por el modelo (`start=4000`) hace
que cada llamada parezca nueva. Costó 534k tokens de entrada una vez. Ver
[[Motor de agentes]].

### El mensaje de error es parte de la herramienta

Es lo único que el agente puede leer para corregirse. Un rechazo tiene que decir
**qué hacer en su lugar**: `puedeBorrar` nombra a quién escalarle, `assign_task`
devuelve la lista del equipo real, `buscarEntregable` lista las claves que
existen.

### Corte por tiempo si sale a la red
Sin excepción. Ver [[Invariantes de arquitectura]] §13.

### `readOnly` y `requiresApproval`
- `readOnly: true` → el motor puede ejecutarla en paralelo. Sé honesto.
- `requiresApproval: true` → **no se ejecuta**: abre una aprobación. Candidatas:
  cualquier cosa con costo o que escriba en un sistema externo.

### Operaciones en lote
Si el agente va a necesitar hacerlo N veces, dale un argumento de lote.
`delete_files` acepta `kind` porque encadenar una llamada por archivo hacía que el
agente fallara a la mitad.

## Lista de control

- [ ] origen correcto
- [ ] `additionalProperties: false`
- [ ] `description` que un modelo entienda sin contexto extra
- [ ] mensajes de error que digan qué hacer
- [ ] corte por tiempo si sale a la red
- [ ] `readOnly` honesto
- [ ] registrada en los seeds si es `skill` o `capability`
- [ ] test del camino feliz **y** del error
- [ ] [[Catálogo de herramientas]] y [[Referencia de herramientas]] actualizados

## Enlaces

- [[Herramientas y tool router]]
- [[Habilidades de producción]]
