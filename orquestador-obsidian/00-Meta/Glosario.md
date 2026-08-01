---
tags: [meta, referencia]
aliases: [Términos, Vocabulario]
---

# Glosario

Los términos del dominio, tal como los usa el código. Cuando una palabra tiene
una nota propia, está enlazada.

| Término | Definición | Dónde vive |
|---|---|---|
| **Empresa** (`Company`) | La unidad de configuración: misión, contexto de negocio, moneda, presupuesto por corrida, modelo por defecto y voz de marca. Todo lo demás cuelga de acá. | `packages/shared/src/schema.ts` |
| **Departamento** (`Department`) | Agrupador de roles con un propósito. Puede tener padre: el organigrama es un árbol. | ídem |
| **Rol** (`Role`) | **Un agente.** Tiene prompt propio, modelo propio, bandeja propia, herramientas asignadas, nivel de autoridad y a quién le reporta. Persiste entre ticks. | [[Modelo de dominio]] |
| **Autoridad** (`AuthorityLevel`) | `executor` \| `manager` \| `executive`. Determina qué decide solo y qué escala, y qué puede borrar. | [[Coordinación entre agentes]] |
| **Política** (`Policy`) | Regla de negocio. El texto va al prompt de los roles alcanzados; el `gate` opcional se evalúa **en código** antes de dejar pasar una acción. | [[Modelo de dominio]] |
| **Corrida** (`Run`) | Una ejecución de la empresa contra un encargo (`objective`), con tope de ciclos y de presupuesto. Efímera: no sobrevive al reinicio del servidor. | [[Scheduler y ciclo de una corrida]] |
| **Tick** / ciclo | Una vuelta de la empresa: se toman los roles con trabajo pendiente, ejecutan turno en paralelo acotado, y lo que emiten entra a las bandejas **del ciclo siguiente**. | [[Scheduler y ciclo de una corrida]] |
| **Turno** | Lo que hace un rol dentro de un tick: una o varias iteraciones del agent loop (pensar → llamar herramientas → volver a pensar), acotadas por `maxTurns`. | [[Motor de agentes]] |
| **Misión** (`Mision`) | La **receta** de una corrida más cuándo repetirla. Se dispara sola. No confundir con `mode: "cron"`, que pacea los ciclos *dentro* de una corrida. | [[Misiones programadas]] |
| **Entregable** (`Artifact`) | Un documento versionado que produce la empresa, identificado por `key`. Vive a nivel **empresa** y sobrevive a que se borre su corrida. | [[Habilidades de producción]] |
| **Salida** / directorio de salida | `data/exports/<empresa>/`: los archivos reales (Word, PDF, video, deck, imágenes) sobre los que los agentes crean, modifican y borran. | [[Habilidades de producción]] |
| **Herramienta** (`Tool`) | Función que el agente invoca por function-calling. Cuatro orígenes: `coordination`, `capability`, `skill`, `mcp`. | [[Catálogo de herramientas]] |
| **Habilidad** (`skill`) | Origen de herramienta que agrupa **lo que un rol sabe producir**: `export_docx`, `export_pdf`, `export_video`, `export_slides`, `generar_imagen`. | [[Habilidades de producción]] |
| **Tool router** | Acota las herramientas **opcionales** que se le pasan al modelo cuando el catálogo supera el umbral. Coordinación y habilidades no compiten por esos lugares. | [[Herramientas y tool router]] |
| **Tier** | Atajo para elegir modelo sin nombrar un slug: `free`, `cheap`, `standard`, `smart`. Se resuelve contra el catálogo vivo del proveedor, por precio real. | [[Capa LLM y tiers]] |
| **Ledger** | Registro de costo por llamada: tokens de entrada, de salida, cacheados, USD y latencia. Es lo que corta la corrida al pasarse del tope. | [[Costos y presupuesto]] |
| **Traza** / evento (`TraceEvent`) | Cada paso del motor emite uno. El servidor los persiste y los reemite por SSE; la UI deriva su estado de ahí. | [[Observabilidad y trazas]] |
| **Aprendizaje** (`Learning`) | Lección que vive a nivel **empresa** y sobrevive a la corrida. Se inyecta en el prompt de sistema. | [[Memoria de la empresa]] |
| **Solicitud del agente** (`AgentRequest`) | Lo que un agente le pide a **la persona**: crear un rol, un dato del negocio, acceso a una herramienta. Bandeja aparte de la mensajería entre agentes. | [[Coordinación entre agentes]] |
| **Aprobación** (`ApprovalRequest`) | Una herramienta marcada `requiresApproval` no se ejecuta: abre una solicitud y esa rama del trabajo queda detenida. | [[Modelo de dominio]] |
| **Blueprint** (`CompanyBlueprint`) | La empresa entera como un JSON serializable: se exporta, se versiona en git y se importa en otra instalación. Sin credenciales adentro. | [[Modelo de dominio]] |
| **MCP** | Model Context Protocol. Servidores externos que aportan herramientas, descubiertas al conectar y nombradas `mcp__<servidor>__<tool>`. | [[Integración MCP]] |
| **Presión de cierre** | Lo que se le inyecta al turno según cuánto queda de ciclos y presupuesto, para que la empresa cierre en un entregable en vez de morir pidiéndose datos. | [[Motor de agentes]] |
| **Guion** | Un entregable markdown leído como línea de tiempo: `#` es la portada, cada `##` abre una escena, los párrafos son voz en off. Alimenta video y deck. | [[Producción audiovisual]] |
| **Publicar** | Mover un archivo a `publicado/`. Es lo único del circuito que un agente **no** puede hacer. | [[Misiones programadas]] |
