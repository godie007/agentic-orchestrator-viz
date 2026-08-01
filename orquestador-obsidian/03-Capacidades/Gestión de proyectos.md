---
tags: [capacidad]
aliases: [Proyectos, Crear empresa, Pantalla de proyectos]
---

# Gestión de proyectos

> Un **proyecto** es una empresa completa: agentes, departamentos, políticas,
> herramientas, memoria, misiones y su propio directorio de salida.

`apps/web/src/routes/Proyectos.tsx`. Es la **primera pestaña y la pantalla
inicial**: con más de una empresa cargada, lo primero que hay que decidir es con
cuál se trabaja.

## Proyecto vs. empresa

El rótulo "proyecto" existe **sólo en esta pantalla**. Adentro se sigue hablando
de empresa, agentes y departamentos, y el dominio sigue siendo `Company` /
`companyId`.

Es deliberado: toda la metáfora del producto es organizacional —organigrama,
jerarquía, quién le reporta a quién, un CEO que delega— y renombrarla a
"proyecto" la dejaría sin sentido. Lo que sí es un proyecto es **la unidad de
trabajo**: elegís uno y trabajás adentro.

## Qué hace

| Acción | Detalle |
|---|---|
| **Crear** | nombre y misión. El resto se edita adentro |
| **Abrir** | lo selecciona y lleva al diseñador — abrir un proyecto es entrar a él |
| **Borrar** | el proyecto entero: base, conexiones MCP y carpeta de salida |
| **Ficha** | agentes, áreas, misiones, corridas, entregables, peso en disco, última corrida y si está trabajando ahora |

La ficha existe para **decidir sin entrar**: con cuatro proyectos, "¿cuál era el
que no usé nunca?" se contesta mirando la tarjeta, no abriéndolos de a uno.

Un proyecto con una corrida viva **no se puede borrar**: el botón queda
deshabilitado y el `title` dice por qué. El servidor lo verifica igual (409): la
guardia de la UI es comodidad, no seguridad.

## Un proyecto nuevo nace usable

`POST /api/companies` ahora llama a `Runtime.sembrarHerramientas`.

> [!danger] Sin eso, el proyecto nace sin nada que asignarle a un agente
> `ToolRegistry.forRole` sólo regala las de coordinación; las de `capability` y
> `skill` dependen de `role.toolIds`, que apunta a filas de la tabla `tools`. Un
> proyecto creado desde la UI no tenía ninguna, y el primer agente al que le
> pidieras un PDF respondía —con razón— que no encuentra `export_docx`.
>
> Es la misma siembra que hace `npm run db:seed`, y la misma trampa que
> documenta [[Invariantes de arquitectura]] §7.

Verificado: un proyecto recién creado desde la pantalla queda con **11
herramientas** registradas — las 8 habilidades más `web_search`, `fetch_url` y
`send_email`.

Las de **coordinación quedan afuera** a propósito: se otorgan siempre, y
mostrarlas en el asignador las presentaría como si se pudieran quitar.

El tier por defecto es `standard`, no `cheap`: es el que sirve para los roles que
coordinan, y bajarlo después es más barato que descubrir por qué el ejecutivo se
fue por las ramas. Ver [[Capa LLM y tiers]].

## El resumen es una consulta agregada

`Store.resumenEmpresas()` cuenta con `GROUP BY` en vez de traer las filas: la
pantalla muestra todos los proyectos juntos, y cargar los entregables de cada uno
para después contarlos sería traerse **el contenido entero de cada documento** a
memoria.

> [!warning] Un `GROUP BY` a secas pierde los proyectos vacíos
> El que no tiene ninguna fila en ninguna tabla no aparece en ningún resultado y
> se caía de la lista — y ése es justamente el proyecto recién creado, el único
> que hay que poder abrir. Se parte de `listCompanies()` y las cuentas se cruzan
> encima, con cero por defecto. Hay un test.

El peso en disco sale de `ExportStore.medirEmpresa`, que **no crea la carpeta**:
medir con `dirFor` dejaría un directorio por proyecto con sólo mirar la lista.
Ver [[Limpieza y mantenimiento]].

## Navegación

Dos reglas que salieron de romperlo:

- **`SIN_PROYECTO`** (`App.tsx`): Proyectos y Proveedores no exigen uno
  seleccionado. Sin esa excepción, una instalación nueva es un callejón sin
  salida: la pantalla donde se crea el primer proyecto pediría un proyecto.
- **Borrar el proyecto activo suelta la selección.** `App` guarda cuál está
  elegida; si no la suelta, `activeId` apunta a un id muerto. Lo hacen tanto
  `onBorrado` (desde Proyectos) como `onCompanyGone` (desde Mantenimiento).
- **`company.isError` no es `isLoading`.** Un proyecto borrado desde otra pestaña
  deja la consulta en error; sin distinguirlas, la pantalla decía "Cargando…"
  para siempre.

## API

| Método | Ruta |
|---|---|
| `GET` | `/api/companies/resumen` — una línea por proyecto |
| `POST` | `/api/companies` — crea y **siembra las herramientas built-in** |
| `DELETE` | `/api/companies/:id` — base, MCP y disco; 409 con corrida viva |

## Lo que todavía no hace

Exportar e importar blueprint desde la UI (los endpoints existen, ver
[[Base de datos]]) y duplicar un proyecto como plantilla.

## Enlaces

- [[Limpieza y mantenimiento]] — el borrado por dentro
- [[Frontend web]]
- [[Empresas de ejemplo]] — cómo armar una desde cero
