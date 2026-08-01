---
tags: [adr, arquitectura, seguridad]
---

# ADR-008 Publicar lo decide una persona

**Estado:** aceptada

## Contexto

Una [[Misiones programadas|misión]] puede correr sola, producir un video
institucional y avisar por correo. La pregunta es dónde termina la autonomía.

## Decisión

**Publicar es lo único del circuito que un agente no puede hacer.**

La misión produce, avisa y **espera**. `ExportStore.publicar` mueve el archivo a
`publicado/` dentro del directorio de la empresa, y el botón está en la pestaña
**Salida** de la UI. No existe una herramienta `publicar` en el catálogo.

## Alternativas consideradas

**Un estado `aprobado` en la base.** Rechazada: mover el archivo hace que
"aprobado" sea **un hecho verificable en el disco** y no un estado que hay que
creer. Un `SELECT` puede decir cualquier cosa; un archivo está en `publicado/` o
no está.

**Una herramienta `publicar` con `requiresApproval: true`.** Rechazada por ser
una vuelta larga al mismo lugar: la aprobación la resolvería un rol con
autoridad, no necesariamente una persona, y `approverRoleId` puede apuntar a otro
agente.

**Autonomía completa con posibilidad de revertir.** Rechazada: revertir una
publicación no deshace que alguien la haya visto.

## Consecuencias

### A favor
- El circuito completo —producir, avisar, revisar, publicar— tiene un humano en
  el punto donde el error sale de la empresa.
- Se verifica mirando el disco, no consultando un estado.
- Es compatible con misiones desatendidas: la misión no se traba esperando,
  simplemente deja el archivo listo.

### En contra / lo que se resignó
- **No hay automatización de punta a punta.** Si querés que una misión publique
  sola, no se puede — y esa es la decisión.
- Alguien tiene que mirar los avisos. Sin eso, los entregables se acumulan sin
  publicar.

## Reglas relacionadas, con alcances distintos

No confundir las tres:

| Regla | Alcance | Quién decide |
|---|---|---|
| **Publicar** | mover a `publicado/` | **sólo una persona**, desde la UI |
| **Borrar como agente** (`puedeBorrar`) | según `authority`: `executive` da de baja cualquier cosa, `manager` sólo material de apoyo, `executor` no borra | el ejecutor de la herramienta, en código |
| **Borrar desde la UI** | cualquier archivo | vos, con confirmación y sin papelera |

Y una regla que atraviesa a las tres: **un agente sólo borra lo suyo**.
`removeComoAgente` acepta multimedia o archivos que la empresa generó; lo que
trajo una persona lo rechaza. La procedencia vive en `.orq-generado.json`, y si
el manifiesto no existe, **todo cuenta como externo: falla seguro**.

Ver [[Habilidades de producción]] y [[Seguridad]].
