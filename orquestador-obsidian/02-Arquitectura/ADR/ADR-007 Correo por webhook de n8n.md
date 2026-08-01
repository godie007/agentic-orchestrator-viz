---
tags: [adr, arquitectura]
---

# ADR-007 Correo por webhook de n8n

**Estado:** aceptada

## Contexto

Una [[Misiones programadas|misión]] produce algo y **tiene que avisar**: sin
aviso, un encargo programado pasa sin que nadie se entere, y el circuito
"producir → revisar → publicar" se corta en el primer eslabón.

## Decisión

El orquestador **no habla SMTP**. `packages/tools/src/correo.ts` le pasa el
mensaje a un webhook de n8n (`N8N_EMAIL_WEBHOOK_URL`) y ese flujo decide con qué
cuenta sale.

Contrato del POST:

```json
{
  "to": ["persona@empresa.com"],
  "subject": "…",
  "text": "…",
  "attachments": [{ "filename": "video.mp4", "url": "http://…" }],
  "source": "orquestador-agentico"
}
```

**Los nombres van en inglés** (`to`, `subject`, `text`, `attachments`) aunque
todo el resto del código esté en castellano: son los campos del nodo *Send Email*
de n8n, así que del otro lado es un mapeo y no una traducción.

## Alternativas consideradas

**SMTP directo (nodemailer).** Rechazada: obliga al orquestador a administrar
credenciales de casilla, dominios, SPF/DKIM y rebotes — problemas de correo, no
de orquestación. Y cada empresa querría su propia cuenta.

**Un proveedor de correo transaccional.** Misma objeción, más un vendor lock-in
que no compra nada acá.

## Consecuencias

### A favor
- Cambiar de cuenta o de proveedor de correo es cambiar el flujo de n8n, sin
  tocar el orquestador.
- El flujo puede hacer cosas que el orquestador no debería: enrutar por
  destinatario, agregar firma corporativa, registrar en un CRM.

### En contra / lo que se resignó
- **Una dependencia externa para una función del circuito.** Se mitiga con un
  modo degradado explícito: sin `N8N_EMAIL_WEBHOOK_URL`, las misiones corren
  igual pero no avisan, y `send_email` **falla diciendo exactamente qué falta y
  de quién es el problema** — no falla en silencio ni con un error genérico.
- No hay confirmación de entrega: el orquestador sabe que el webhook aceptó el
  mensaje, no que llegó.

### Los adjuntos van como enlace, no como bytes
El enlace apunta al **servidor local** (`API_URL`). Sirve para que quien recibe
el aviso lo abra desde la misma máquina o red donde corre el orquestador, no
desde cualquier lado. Es una limitación deliberada: los entregables de una
empresa no salen a internet por un aviso automático.

Ver [[Correo y avisos]] y [[Misiones programadas]].
