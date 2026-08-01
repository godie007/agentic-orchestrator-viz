---
tags: [adr, arquitectura]
---

# ADR-005 Las habilidades trabajan sobre entregables ya escritos

**Estado:** aceptada

## Contexto

Una habilidad como `export_pdf` necesita el contenido del documento. La forma
obvia es recibirlo como argumento de la llamada a herramienta.

## Decisión

Las habilidades reciben **la clave de un entregable ya escrito**, nunca el
contenido. El agente guarda con `write_artifact` y después pasa la `key`.

```
write_artifact(key: "propuesta-acme", content: "# ...")   ← el contenido
export_pdf(key: "propuesta-acme", folder: "propuestas")   ← sólo la clave
```

## Alternativas consideradas

**Recibir el contenido por argumento.** Rechazada por un modo de falla concreto:
un documento largo pasado como argumento **se trunca cuando el modelo agota
`max_tokens` a mitad del JSON**, y perdés el documento entero — no una parte, el
entero, porque el JSON queda inválido.

**Recibir el contenido y guardarlo la habilidad.** Mismo problema: el truncado
ocurre antes de que la herramienta se ejecute.

## Consecuencias

### A favor
- La exportación **no puede romper el contenido**: ya está guardado y versionado.
- Un entregable se exporta a varios formatos sin re-generarlo: el markdown se
  parsea **una sola vez** a bloques neutros (`skills/markdown.ts`) y de ahí salen
  Word, PDF, video y deck. Las salidas no pueden decir cosas distintas.
- El entregable sobrevive a la corrida y se versiona: otra área lo lee y lo
  continúa. Ver [[Persistencia y esquema SQL]].

### En contra / lo que se resignó
- **Dos llamadas** donde podría haber una. Cuesta una iteración del agent loop.
- Hay que enseñarle al agente el flujo de dos pasos, y el error importa: cuando
  la clave no existe, `buscarEntregable` explica **qué claves sí existen** — un
  "no existe" a secas hace que vuelva a intentar con la misma clave inventada.

## Decisiones derivadas

### `write_artifact` rechaza lo que no es un entregable
`revisarCalidad` bloquea un título que habla del proceso interno ("Ciclo 2",
"Bandeja de entrada") o un muro de más de 400 caracteres sin una sola sección.
El render maqueta lo que recibe, pero no puede inventar una estructura que no
está. **Se verifica en la herramienta y no sólo en el prompt**: un agente puede
ignorar una instrucción, no al ejecutor.

### `write_artifact` rechaza claves que son variantes de una existente
`-ciclo3`, `_v2`, `-final`, y sufijos colgados como `-detalle`. Se le pide que
versione la original. Los modelos baratos fragmentan el entregable si esa guardia
no está.

### Un archivo por entregable y formato
`key.pdf`, no `key-v3.pdf`. Con la versión en el nombre, cada re-exportación
dejaba otro archivo y pedir un PDF terminaba en v1, v2 y v3 conviviendo. La
versión va en la portada, y al exportar se borran los `key-vN.ext` de la forma
vieja.

Ver [[Habilidades de producción]].
