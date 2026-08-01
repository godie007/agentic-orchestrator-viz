---
tags: [operación, seguridad]
aliases: [Seguridad, Modelo de amenaza]
---

# Seguridad

## Alcance

Corre **local, un solo usuario**. No hay autenticación de la propia herramienta
ni aislamiento entre usuarios: eso está fuera de alcance en esta versión. El
modelo de amenaza es "un agente LLM hace algo que no debería", no "un atacante
remoto".

## Credenciales

### API keys de proveedores
Van en `.env`, que está **git-ignored**.

> Si alguna vez pegaste una API key en un chat, **rotala**: quedó en el historial
> de esa conversación.

### Secretos de servidores MCP
Se guardan **por referencia**: la configuración almacena el **nombre** de la
variable de entorno, nunca el valor.

```jsonc
"envRefs": { "GITHUB_TOKEN": "GITHUB_TOKEN" }
```

El valor se resuelve al conectar (`env.ts` → `resolveSecret`). Consecuencia
directa: **una empresa exportada a JSON no lleva credenciales adentro**, así que
se puede versionar en git y compartir.

**Mantené esa regla al agregar campos de configuración MCP.**

## Superficie de red

### `fetch_url` bloquea la red interna
Loopback, rangos privados y link-local. Para que un prompt no pueda usar a un
agente para escanear la red del host (`packages/tools/src/capability.ts` →
`isPrivateHost`).

### Corte por tiempo en toda llamada saliente
Un endpoint que acepta la conexión y se queda callado deja el turno esperando
para siempre: el agente no falla, no sigue, y no se le puede pedir que cambie de
enfoque. Medido con el endpoint de imágenes de NVIDIA.

### `caPath` verifica, no saltea
Para servidores MCP HTTP con certificado propio. Es la ruta a la CA que firma el
certificado — no es un secreto y no desactiva la verificación.

### Los adjuntos de correo van como enlace al servidor local
No como bytes, y el enlace apunta a `API_URL`. Los entregables de una empresa no
salen a internet por un aviso automático. Ver [[Correo y avisos]].

## Filesystem

### Los agentes no tienen acceso directo
Ni a filesystem ni a shell. Eso entra por [[Integración MCP|MCP]] y queda visible
en el Hub como cualquier otra conexión.

### Saneo segmento por segmento
`ExportStore.safePath` limpia **cada segmento** de toda ruta que propone un
agente, así que se escribe y se borra dentro del directorio de la empresa y en
ningún otro lado.

### `packages/tools` no lee el disco
Recibe `resolverImagen` del servidor, que es quien sanea la ruta que propuso un
modelo. La frontera es deliberada.

## Qué puede borrar un agente

Dos reglas independientes, las dos tienen que dar permiso:

1. **Sólo lo suyo.** `removeComoAgente` acepta multimedia o archivos que la
   empresa generó; lo que trajo una persona lo rechaza. La procedencia vive en
   `.orq-generado.json`, oculto, dentro del directorio de la empresa.

   > **Si el manifiesto no existe, todo cuenta como externo: falla seguro.**

2. **Según su autoridad.** `executive` da de baja cualquier cosa; `manager` sólo
   material de apoyo —no un `.docx` ni un `.pdf`—; `executor` no borra. En lote
   se filtra **antes** de borrar: un `kind` amplio no puede ser la vía para
   saltear la jerarquía.

**Producir queda abierto** para los tres: un ejecutor tiene que poder trabajar sin
pedir permiso.

El borrado **desde la UI** no pasa por ninguna de las dos: ahí decidís vos, con
confirmación y sin papelera.

## Qué no puede hacer un agente

**Publicar.** `ExportStore.publicar` mueve el archivo a `publicado/`, y el botón
está en la pestaña Salida. No existe una herramienta `publicar` en el catálogo.
Ver [[ADR-008 Publicar lo decide una persona]].

## Aprobaciones

Las herramientas marcadas `requiresApproval` **no se ejecutan**: abren una
solicitud y esa rama del trabajo queda detenida hasta que alguien resuelva.

Candidatas a marcarlas: `send_email`, cualquier tool de MCP que escriba en un
sistema externo, cualquier cosa con costo.

## Contenido generado en el navegador

Un deck `.html` que escribió un agente se dibuja en un **iframe con `sandbox`
vacío**: se sirve desde el mismo origen que la aplicación, y no puede correr con
su sesión.

## Costo como control de seguridad

El tope de gasto corta la corrida, pero **se evalúa antes de cada turno, no
durante**: una sola llamada cara puede pasarse. Configurá también un límite en el
dashboard de tu proveedor. Ver [[Costos y presupuesto]].

## El aviso de `npm audit`

`GHSA-frvp-7c67-39w9` sobre `@hono/node-server`, arrastrado por
`@modelcontextprotocol/sdk`:

- **No es alcanzable**: el SDK sólo referencia hono desde su lado servidor, y
  este proyecto importa exclusivamente el lado cliente — verificado con grep
  sobre el paquete instalado.
- **No se aplica un override** porque la corrección está en la línea 2.x y el SDK
  depende de `^1.x`: forzar ese salto de major puede romper el SDK, un riesgo
  real frente a una vulnerabilidad inalcanzable.

La nota completa está en `package.json → auditNotes`. Revisar al subir el SDK
(última revisión: 1.29.0). **No lo "arregles" sin leer esa nota.**

## Enlaces

- [[Integración MCP]]
- [[Habilidades de producción]]
- [[Variables de entorno]]
- [[Estado del producto]]
