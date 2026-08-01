---
tags: [capacidad]
aliases: [Correo, n8n, send_email]
---

# Correo y avisos

`packages/tools/src/correo.ts` → `crearCorreo` y `createEmailTools`.

## El correo sale por un webhook de n8n, no por SMTP

El orquestador **no habla SMTP**: le pasa el mensaje al flujo y ese decide con
qué cuenta sale. Ver [[ADR-007 Correo por webhook de n8n]].

## El contrato

`POST` a `N8N_EMAIL_WEBHOOK_URL`:

```json
{
  "to": ["persona@empresa.com"],
  "subject": "Video institucional listo para revisar",
  "text": "La misión «Institucional semanal» produjo…",
  "attachments": [
    { "filename": "institucional.mp4", "url": "http://localhost:3001/api/…" }
  ],
  "source": "orquestador-agentico"
}
```

> [!info] Por qué los nombres van en inglés
> `to`, `subject`, `text`, `attachments` son los campos del nodo *Send Email* de
> n8n. Así, del otro lado es un **mapeo y no una traducción**.

## Los adjuntos viajan como enlace, no como bytes

El enlace apunta al servidor local (`API_URL`, por defecto
`http://localhost:3001`).

> Sirve para que quien recibe el aviso lo abra **desde la misma red**, no desde
> cualquier lado. Los entregables de una empresa no salen a internet por un aviso
> automático.

## Sin configurar, falla diciendo qué falta

Sin `N8N_EMAIL_WEBHOOK_URL`:

- las [[Misiones programadas|misiones]] corren igual, pero **no avisan**;
- `send_email` falla diciendo **exactamente qué falta y de quién es el
  problema** — no en silencio ni con un error genérico.

Es el mismo criterio que en el resto del sistema: un modo degradado explícito
vale más que una falla misteriosa. Ver [[Producción audiovisual]].

## Dos usos

### 1. Aviso automático de misión
`MisionScheduler` avisa a `mision.avisarA` cuando la corrida termina, con qué
produjo y el enlace para mirarlo. Ver [[Misiones programadas]].

### 2. `send_email` como herramienta
Un agente con la herramienta asignada puede mandar un correo desde su turno. Se
asigna por `toolIds`, como cualquier capacidad.

> [!warning] Es una acción hacia afuera
> Considerá marcarla `requiresApproval` en empresas donde un correo mal mandado
> tenga costo. Ver [[Seguridad]].

## Configuración del lado de n8n

El flujo mínimo es un nodo *Webhook* → *Send Email*, mapeando los cuatro campos.
`source` sirve para filtrar en el flujo si el mismo webhook recibe de varios
lados.

Ver [[Variables de entorno]] para `N8N_EMAIL_WEBHOOK_URL`, `API_URL` y `APP_URL`.

## Enlaces

- [[ADR-007 Correo por webhook de n8n]]
- [[Misiones programadas]]
- [[CU-03 Misión semanal con aprobación humana]]
