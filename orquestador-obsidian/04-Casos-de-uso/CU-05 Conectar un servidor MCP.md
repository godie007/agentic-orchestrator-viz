---
tags: [caso-de-uso]
aliases: [CU-05, MCP, Conectar herramientas]
---

# CU-05 Conectar un servidor MCP

**Qué se quiere lograr:** sumarle a la empresa herramientas que no están
construidas adentro —filesystem, memoria, una API de terceros— y dárselas a los
roles que las necesitan.

## Configuración

### 1. Definir el servidor

Pestaña **Empresa**, o en el blueprint:

```jsonc
// stdio
{
  "name": "filesystem",              // sólo [a-z0-9_-]
  "description": "Lectura de la bóveda de documentación",
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/ruta/permitida"],
    "envRefs": {},
    "cwd": null
  },
  "enabled": true,
  "autoApproveTools": true
}
```

```jsonc
// http
{
  "name": "interno",
  "transport": {
    "type": "http",
    "url": "https://mcp.interno.empresa/",
    "headerRefs": { "Authorization": "MCP_INTERNO_TOKEN" },
    "caPath": "/etc/ssl/certs/interno-ca.pem"
  }
}
```

> [!important] Los secretos van por referencia
> `headerRefs` guarda el **nombre** de la variable de entorno
> (`MCP_INTERNO_TOKEN`), no el valor. El valor sale de `process.env` al conectar.
> Así una empresa exportada a JSON **no lleva credenciales adentro**. Ver
> [[Seguridad]].

`caPath` es la ruta a la CA que firma el certificado, para servidores con
certificado propio. Sirve para **verificar**, no para saltear la verificación.

### 2. Conectar

Al arrancar el runtime de empresa. En el **MCP Hub** se ve el semáforo pasar de
`connecting` a `ready`, con la latencia del handshake y cuántas herramientas
descubrió.

## El recorrido

### 3. Probar sin arrancar la empresa

El **probador manual** del Hub
(`POST /api/companies/:companyId/mcp/probe`) ejecuta una tool y muestra qué
devuelve.

> Es la forma más barata de descartar que el problema sea del servidor MCP y no
> del agente. Hacelo **antes** de gastar una corrida.

### 4. Dar acceso

La matriz **"Quién usa qué"** es también el editor: un clic le da o le quita a un
agente **todas** las herramientas de un servidor.

Las tools quedan nombradas `mcp__filesystem__read_file`. Se asignan por
`toolIds`, como cualquier capacidad.

> [!info] Las de coordinación no se pueden quitar
> Si tocás esa UI, no las presentes como si se pudieran. Ver
> [[Invariantes de arquitectura]] §6.

### 5. Usarlas en una corrida

El agente las ve en su lista, y `tool.selection` deja registro de si entraron o
las acotó el router.

## Qué mirar

| Dónde | Qué demuestra |
|---|---|
| **Semáforo** | `handshakeMs`: si tarda segundos, el servidor arranca lento y eso se paga en cada reconexión |
| **Invocaciones / errores** | cuáles se usan de verdad. Una tool con 0 invocaciones en varias corridas es contexto que se paga y no rinde |
| **`tool.selection`** | con muchas tools de MCP, `strategy: "ranked"` y el motivo |
| **Canal SSE global** | `/api/mcp/stream` sigue emitiendo aunque no haya ninguna corrida |

## Qué puede salir mal

| Síntoma | Causa |
|---|---|
| el semáforo queda en `error` | comando mal, ruta inexistente, o la variable de `envRefs` no está en `.env` |
| el agente insiste con una ruta fuera del directorio permitido | el corte por repetición lo frena a la tercera; sin él le comía las `maxTurns` enteras |
| un agente se queda sin su propia `export_pdf` | ya corregido: el router acota **las opcionales**, no el total. Ver [[Herramientas y tool router]] |
| `npm audit` grita por `@hono/node-server` | **no es alcanzable** — leé `package.json → auditNotes` antes de "arreglarlo" |
| certificado rechazado en un servidor HTTP interno | falta `caPath` |

## Cuántas conectar

Con dos o tres servidores el catálogo llega a decenas de tools. El router acota
por encima de 25 (`threshold`), exponiendo 12 opcionales. Más allá de eso, el
costo de contexto sube y la elección del modelo se degrada — asigná por rol en
vez de darle todo a todos.

## Enlaces

- [[Integración MCP]]
- [[Herramientas y tool router]]
- [[Seguridad]]
