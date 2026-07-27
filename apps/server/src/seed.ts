
import { mkdirSync } from "node:fs";
import { ids } from "@orq/shared";
import type {
  Company,
  Department,
  McpServer,
  ModelSelection,
  Policy,
  Role,
  Tool,
} from "@orq/shared";
import { ToolRegistry } from "@orq/tools";
import { Store } from "./db.js";
import { fromRoot, loadEnv } from "./env.js";

/**
 * Empresa de ejemplo: Codytion S.A.
 *
 * Sirve para ver el sistema funcionando en un minuto sin configurar nada. Está
 * armada para que el proceso se note: hay delegación en cascada, un
 * escalamiento probable hacia el CEO, un umbral de aprobación en Finanzas y dos
 * servidores MCP conectados.
 *
 *   npm run db:seed
 */

const env = loadEnv();
const store = new Store(env.databaseUrl);

/** Los roles rutinarios corren barato; las decisiones difíciles pagan más. */
const model = (tier: ModelSelection["tier"]): ModelSelection => ({
  providerId: "openrouter",
  modelSlug: null, // se resuelve contra el catálogo vivo al arrancar la corrida
  tier,
  temperature: null,
  maxOutputTokens: 4096,
});

const now = Date.now();
const company: Company = {
  id: ids.company(),
  name: "Codytion S.A.",
  mission:
    "Diseñamos e implementamos software a medida para empresas medianas de Latinoamérica.",
  context: `Somos una consultora de software de 40 personas con sede en Bogotá.
Vendemos proyectos de entre US$30.000 y US$250.000, con ciclos de venta de 4 a 10 semanas.
Nuestros clientes típicos son retail, logística y servicios financieros.
El margen objetivo por proyecto es 35%. Trabajamos con equipos de 3 a 6 personas por proyecto.`,
  currency: "USD",
  budgetUsd: 1,
  defaultModel: model("standard"),
  createdAt: now,
  updatedAt: now,
};

const dep = (name: string, purpose: string, x: number, y: number): Department => ({
  id: ids.department(),
  companyId: company.id,
  name,
  purpose,
  parentId: null,
  position: { x, y },
});

const dirección = dep("Dirección", "Define la estrategia y decide sobre la empresa.", 400, 0);
const comercial = dep("Comercial", "Consigue y cierra negocios nuevos.", 100, 200);
const operaciones = dep("Operaciones", "Diseña y entrega las soluciones técnicas.", 400, 200);
const finanzas = dep("Finanzas", "Cuida el margen, los precios y el flujo de caja.", 700, 200);
const marketing = dep("Marketing", "Genera demanda y posiciona la marca.", 100, 400);
const soporte = dep("Soporte", "Atiende a los clientes existentes.", 700, 400);

const departments = [dirección, comercial, operaciones, finanzas, marketing, soporte];

// --- Herramientas built-in que se asignan a los roles ------------------------
// El registro conoce las herramientas; acá se les da un id para poder
// referenciarlas desde la configuración de cada rol.
const registry = new ToolRegistry();
const builtinTools: Tool[] = registry
  .describe()
  .filter((tool) => tool.origin === "capability")
  .map((tool) => ({ ...tool, id: ids.tool() }));

const toolId = (name: string): string =>
  builtinTools.find((tool) => tool.name === name)?.id ?? "";
const web = [toolId("web_search"), toolId("fetch_url")].filter(Boolean);

// --- Roles -------------------------------------------------------------------

const ceo: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: dirección.id,
  name: "Valentina Ríos",
  title: "CEO",
  systemPrompt: `Dirigís Codytion. Tu trabajo es decidir y desbloquear, no ejecutar.
Cuando llega un encargo, lo descomponés y lo delegás a la dirección que corresponda,
con un objetivo claro y un criterio de "terminado". Después integrás lo que te devuelven.
No hacés análisis vos misma: para eso tenés equipo. Sí tomás las decisiones que
nadie más puede tomar, y aprobás o rechazás lo que te escalan.`,
  model: model("smart"),
  toolIds: web,
  authority: "executive",
  reportsTo: null,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 400, y: 60 },
};

const rol = (
  department: Department,
  name: string,
  title: string,
  systemPrompt: string,
  overrides: Partial<Role> = {},
): Role => ({
  id: ids.role(),
  companyId: company.id,
  departmentId: department.id,
  name,
  title,
  systemPrompt,
  model: model("standard"),
  toolIds: [],
  authority: "manager",
  reportsTo: ceo.id,
  maxTurns: 8,
  spendApprovalThresholdUsd: null,
  position: { x: department.position.x, y: department.position.y + 60 },
  ...overrides,
});

const comercialDir = rol(
  comercial,
  "Mateo Duarte",
  "Director Comercial",
  `Conducís la venta. Calificás la oportunidad, definís la estrategia comercial y
armás la propuesta con lo que te dan Operaciones (alcance y esfuerzo) y Finanzas (precio).
No inventás números técnicos ni precios: los pedís. Cerrás vos la propuesta final.`,
  { toolIds: web },
);

const opsDir = rol(
  operaciones,
  "Sofía Marín",
  "Directora de Operaciones",
  `Sos la responsable técnica. Traducís una necesidad de negocio en alcance,
arquitectura y estimación de esfuerzo en horas por perfil. Sos conservadora con las
estimaciones y explicitás los supuestos y riesgos. Te apoyás en tu arquitecto.`,
);

const arquitecto = rol(
  operaciones,
  "Diego Salas",
  "Arquitecto de Soluciones",
  `Diseñás la solución técnica: componentes, integraciones, stack y riesgos.
Devolvés un desglose de esfuerzo por módulo en horas. Sos concreto y realista.`,
  {
    model: model("standard"),
    authority: "executor",
    reportsTo: undefined as never,
    position: { x: operaciones.position.x, y: operaciones.position.y + 160 },
    toolIds: web,
  },
);
arquitecto.reportsTo = opsDir.id;

const finanzasDir = rol(
  finanzas,
  "Camila Ortega",
  "Directora Financiera",
  `Cuidás el margen. A partir del esfuerzo estimado calculás costo, precio y margen,
y validás que el negocio cierre por encima del 35% objetivo. Si el precio que pide
Comercial rompe el margen, lo decís y proponés alternativas. Cualquier descuento
que baje el margen del objetivo requiere aprobación de la CEO.`,
  { spendApprovalThresholdUsd: 5000 },
);

const marketingDir = rol(
  marketing,
  "Julián Prieto",
  "Líder de Marketing",
  `Generás demanda y aportás contexto de mercado: qué hace la competencia, qué
lenguaje usa el sector, qué casos de referencia podemos mostrar. Cuando Comercial
prepara una propuesta, le acercás los diferenciales y casos de éxito relevantes.`,
  { authority: "executor", toolIds: web },
);

const soporteLead = rol(
  soporte,
  "Renata Gil",
  "Líder de Soporte",
  `Atendés a los clientes actuales. Conocés los problemas recurrentes de las
implementaciones y aportás ese aprendizaje cuando se arma una propuesta nueva,
para no repetir errores de proyectos anteriores.`,
  { authority: "executor", model: model("cheap") },
);

const roles = [ceo, comercialDir, opsDir, arquitecto, finanzasDir, marketingDir, soporteLead];

// --- Políticas ---------------------------------------------------------------

const policies: Policy[] = [
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Margen mínimo",
    statement:
      "Ninguna propuesta sale con un margen bruto menor al 35% sin aprobación explícita de la CEO.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Estimaciones fundamentadas",
    statement:
      "Toda estimación de esfuerzo se entrega desglosada por módulo y perfil, con los supuestos explícitos.",
    appliesToRoleIds: [opsDir.id, arquitecto.id],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Una sola propuesta",
    statement:
      "La propuesta final es un único entregable con la clave 'propuesta-comercial'. " +
      "Cada revisión es una versión nueva del mismo entregable, no un documento aparte.",
    appliesToRoleIds: [],
    gate: null,
  },
];

// --- Servidores MCP ----------------------------------------------------------
// Dos servidores oficiales sin credenciales, para que el MCP Hub tenga algo que
// mostrar apenas se abre. Se descargan con npx la primera vez.

const workspace = fromRoot("./data/workspace");
mkdirSync(workspace, { recursive: true });

const mcpServers: McpServer[] = [
  {
    id: ids.mcpServer(),
    companyId: company.id,
    name: "archivos",
    description: `Lectura y escritura de archivos en ${workspace}. Le da a la empresa un lugar donde dejar documentos.`,
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", workspace],
      envRefs: {},
      cwd: null,
    },
    enabled: true,
    autoApproveTools: true,
  },
  {
    id: ids.mcpServer(),
    companyId: company.id,
    name: "memoria",
    description:
      "Grafo de conocimiento compartido. Los agentes pueden guardar hechos sobre clientes y proyectos y recuperarlos después.",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      envRefs: {},
      cwd: null,
    },
    enabled: true,
    autoApproveTools: true,
  },
];

// --- Persistir ---------------------------------------------------------------

store.saveCompany(company);
for (const department of departments) store.saveDepartment(department);
for (const tool of builtinTools) store.saveTool(company.id, tool);
for (const role of roles) store.saveRole(role);
for (const policy of policies) store.savePolicy(policy);
for (const server of mcpServers) store.saveMcpServer(server);
store.close();

console.log(`✓ Empresa creada: ${company.name} (${company.id})`);
console.log(`  ${departments.length} departamentos · ${roles.length} roles · ${policies.length} políticas`);
console.log(`  ${mcpServers.length} servidores MCP: ${mcpServers.map((s) => s.name).join(", ")}`);
console.log(`  Workspace de archivos: ${workspace}`);
console.log(`\nArrancá el sistema con: npm run dev`);
