---
tags: [referencia]
aliases: [Seeds, Codytion, Empresas sembradas]
---

# Empresas de ejemplo

Dos empresas sembradas, con propósitos distintos. Son ficticias.

---

## Codytion S.A. — `npm run db:seed`

`apps/server/src/seed.ts`. Es la empresa del [[CU-01 Propuesta comercial]].

**Misión:** diseñamos e implementamos software a medida para empresas medianas de
Latinoamérica.

**Contexto de negocio** (va al prompt de todos los agentes):

> Consultora de software de 40 personas con sede en Bogotá. Proyectos de US$30.000
> a US$250.000, ciclos de venta de 4 a 10 semanas. Clientes típicos: retail,
> logística y servicios financieros. Margen objetivo por proyecto: 35%. Equipos de
> 3 a 6 personas.

**Voz:** `unaSolaVoz: true`, `pronunciacion: { Codytion: "códishon" }` — la marca
no se lee como se escribe.

### Los siete roles

| Rol | Título | Autoridad | Tier | Herramientas |
|---|---|---|---|---|
| Valentina Ríos | CEO | `executive` | **`smart`** | web |
| Mateo Duarte | Director Comercial | `manager` | `standard` | web + exportar |
| Sofía Marín | Directora de Operaciones | `manager` | `standard` | — |
| Diego Salas | Arquitecto de Soluciones | `executor` | `standard` | web |
| Camila Ortega | Directora Financiera | `manager` | `standard` | umbral de aprobación: US$5000 |
| Julián Prieto | Líder de Marketing | `executor` | `standard` | web |
| Renata Gil | Líder de Soporte | `executor` | **`cheap`** | — |

Diego reporta a Sofía; el resto, a la CEO.

### Las decisiones de diseño que vale la pena copiar

- **La CEO en `smart`, Soporte en `cheap`.** Es la palanca de costo más grande:
  quien decide paga más, quien aporta contexto conocido paga menos. Ver
  [[Capa LLM y tiers]].
- **El prompt de la CEO le prohíbe ejecutar**: "Tu trabajo es decidir y
  desbloquear, no ejecutar. No hacés análisis vos misma: para eso tenés equipo."
  Sin esa instrucción, un ejecutivo se pone a trabajar en vez de delegar.
- **Las habilidades sólo al Director Comercial**: es quien cierra la propuesta.
  Darle exportación a todos produce cuatro versiones del mismo documento.
- **El umbral de gasto en Finanzas** (`spendApprovalThresholdUsd: 5000`), no en
  todos.

### Las tres políticas

| Política | Statement | `gate` |
|---|---|---|
| **Margen mínimo** | ninguna propuesta sale con margen bruto < 35% sin aprobación de la CEO | sí |
| **Estimaciones fundamentadas** | supuestos y riesgos explícitos | no |
| **Una sola propuesta** | un entregable, no tres borradores | no |

### MCP
Dos servidores: `archivos` y `memoria`.

---

## Estudio Codytion — `npm run db:estudio`

`scripts/seed-estudio-codytion.ts`. Es la empresa del
[[CU-02 Video institucional]].

**Tier por defecto:** `free`, para poder probarse sin gastar.
`ORQ_SEED_TIER=standard npm run db:estudio` lo cambia.

### Los cuatro roles

| Rol | Título | Autoridad | Herramientas asignadas |
|---|---|---|---|
| Valentina Ríos | Directora de marca | `executive` | `read_artifact`, `list_artifacts`, `check_activity`, `list_output` |
| Julián Prieto | Guionista | `manager` | `write_artifact`, `read_artifact`, `list_artifacts`, `fetch_url` |
| Mariana Losada | Revisora de guion | `manager` | `read_artifact`, `list_artifacts` |
| Nadia Bercovich | Realizadora | `executor` | las de exportar |

### Lo que enseña este seed

- **La directora no escribe: audita.** Tiene `check_activity` y lectura, no
  escritura. Ver [[CU-04 Control de calidad entre agentes]].
- **La revisora sólo lee.** Un revisor que puede escribir termina reescribiendo
  en vez de devolver correcciones.
- **La realizadora es `executor` y tiene todas las habilidades.** Producir queda
  abierto: un ejecutor tiene que poder trabajar sin pedir permiso — pero no puede
  borrar.

### Las tres políticas

**Un solo guion** · **Sólo lo que podemos sostener** · **Se revisa antes de
filmar**.

> [!warning] Registrar las habilidades es obligatorio
> El seed las incluye explícitamente en `toolIds` **y** en la tabla `tools`.
> `npm run db:seed` filtraba sólo `capability`, así que sus roles no podían
> exportar nada y el agente explicaba que no encontraba `export_video`. Ver
> [[Invariantes de arquitectura]] §7.

---

## Armar la tuya

Dos caminos:

1. **Desde la UI**, pestaña Empresa.
2. **Por blueprint**: exportá una de estas, editá el JSON, importalo.

```bash
curl localhost:3001/api/companies/<id>/blueprint > mi-empresa.json
# editar
curl -X POST localhost:3001/api/companies/import \
     -H 'content-type: application/json' -d @mi-empresa.json
```

El blueprint es versionable en git y **no lleva credenciales**. Ver
[[Base de datos]].

### Lista de control

- [ ] `context` de la empresa con los números que importan (márgenes, rangos, tipos de cliente)
- [ ] quien coordina, **nunca en `cheap`**
- [ ] las habilidades en `toolIds` **y** en la tabla `tools`
- [ ] `reportsTo` coherente: la jerarquía se valida en código
- [ ] al menos una política con `gate` si hay decisiones con costo
- [ ] memoria sembrada antes de la primera corrida — es lo más barato que podés hacer

## Enlaces

- [[Modelo de dominio]]
- [[Casos de uso]]
- [[Memoria de la empresa]]
