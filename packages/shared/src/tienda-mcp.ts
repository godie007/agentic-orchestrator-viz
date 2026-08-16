import { z } from "zod";
import { mcpTransportSchema } from "./schema.js";

/**
 * La tienda de servidores MCP: un catálogo curado en el repo.
 *
 * Antes, dar de alta un servidor era pegar el JSON del README a mano. La
 * tienda ofrece los conocidos como artículos con descripción, categoría y
 * variables requeridas, e instalarlos es un click. El catálogo vive en shared
 * porque lo consumen los dos lados: el servidor instala y la web muestra.
 *
 * Reglas que hereda del resto del sistema:
 * - Los `env` van **por referencia** (nombre de variable, nunca el valor).
 * - `envRequeridas` declara de antemano qué credenciales hacen falta: sin la
 *   declaración, una credencial ausente se descubre en el handshake, lejos de
 *   su causa.
 * - Los comandos son los de cada README (npx/uvx): si un paquete se rompe, el
 *   handshake esperado del instalador lo delata y el `docsUrl` dice a dónde ir.
 */

export const categoriaDeTiendaSchema = z.enum([
  "archivos",
  "desarrollo",
  "web",
  "datos",
  "productividad",
  "navegador",
  "comunicacion",
  "conocimiento",
]);
export type CategoriaDeTienda = z.infer<typeof categoriaDeTiendaSchema>;

export const articuloDeTiendaSchema = z.object({
  id: z.string().min(1).max(64),
  nombre: z.string().min(1).max(100),
  descripcion: z.string().min(1).max(500),
  categoria: categoriaDeTiendaSchema,
  /** Nombre de ícono de Lucide, en kebab-case (ej. "github", "globe"). */
  icono: z.string().min(1),
  servidor: z.object({
    /** Segmento `<servidor>` de `mcp__<servidor>__<tool>`. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    description: z.string().default(""),
    transport: mcpTransportSchema,
  }),
  envRequeridas: z
    .array(
      z.object({
        ref: z.string().min(1),
        descripcion: z.string().default(""),
        obligatoria: z.boolean().default(true),
      }),
    )
    .default([]),
  docsUrl: z.string().url(),
});
export type ArticuloDeTienda = z.infer<typeof articuloDeTiendaSchema>;

function stdio(
  command: string,
  args: string[],
  envRefs: Record<string, string> = {},
): ArticuloDeTienda["servidor"]["transport"] {
  return { type: "stdio", command, args, envRefs, cwd: null };
}

/**
 * El catálogo. Curado a mano y validado con su schema en un test, no en
 * runtime: una entrada rota se descubre en CI, no instalando.
 */
export const CATALOGO_MCP: ArticuloDeTienda[] = [
  // --- Archivos y conocimiento ---------------------------------------------
  {
    id: "filesystem",
    nombre: "Sistema de archivos",
    descripcion:
      "Leer, escribir y buscar archivos en un directorio de esta máquina. El directorio permitido es el de trabajo del servidor.",
    categoria: "archivos",
    icono: "folder-open",
    servidor: {
      name: "archivos",
      description: "Acceso a archivos del directorio de trabajo.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "."]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "memory",
    nombre: "Memoria persistente",
    descripcion:
      "Un grafo de conocimiento que sobrevive entre corridas: entidades, relaciones y observaciones que los agentes pueden consultar y ampliar.",
    categoria: "conocimiento",
    icono: "brain",
    servidor: {
      name: "memoria",
      description: "Grafo de conocimiento persistente.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    nombre: "Pensamiento secuencial",
    descripcion:
      "Descompone un problema en pasos revisables: el agente piensa en etapas y puede corregir una etapa sin tirar el razonamiento entero.",
    categoria: "conocimiento",
    icono: "list-ordered",
    servidor: {
      name: "pensamiento",
      description: "Razonamiento paso a paso revisable.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-sequential-thinking"]),
    },
    envRequeridas: [],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "time",
    nombre: "Fecha y hora",
    descripcion:
      "Hora actual y conversión entre husos horarios. Los agentes no tienen reloj: esto les da uno consultable.",
    categoria: "conocimiento",
    icono: "clock",
    servidor: {
      name: "tiempo",
      description: "Hora actual y husos horarios.",
      transport: stdio("uvx", ["mcp-server-time"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  // --- Desarrollo ----------------------------------------------------------
  {
    id: "git",
    nombre: "Git",
    descripcion:
      "Historial, diffs, ramas y estado de repositorios locales. Sólo lectura y operaciones de repo: no toca remotos.",
    categoria: "desarrollo",
    icono: "git-branch",
    servidor: {
      name: "git",
      description: "Operaciones sobre repositorios git locales.",
      transport: stdio("uvx", ["mcp-server-git"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "github",
    nombre: "GitHub",
    descripcion:
      "Issues, pull requests, búsqueda de código y contenidos de repositorios en GitHub.",
    categoria: "desarrollo",
    icono: "github",
    servidor: {
      name: "github",
      description: "API de GitHub: repos, issues, PRs.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-github"], {
        GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN",
      }),
    },
    envRequeridas: [
      {
        ref: "GITHUB_PERSONAL_ACCESS_TOKEN",
        descripcion: "Token personal de GitHub con scope repo.",
        obligatoria: true,
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github",
  },
  {
    id: "gitlab",
    nombre: "GitLab",
    descripcion: "Proyectos, issues y merge requests de GitLab.",
    categoria: "desarrollo",
    icono: "gitlab",
    servidor: {
      name: "gitlab",
      description: "API de GitLab.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-gitlab"], {
        GITLAB_PERSONAL_ACCESS_TOKEN: "GITLAB_PERSONAL_ACCESS_TOKEN",
      }),
    },
    envRequeridas: [
      { ref: "GITLAB_PERSONAL_ACCESS_TOKEN", descripcion: "Token personal de GitLab.", obligatoria: true },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gitlab",
  },
  {
    id: "supabase",
    nombre: "Supabase",
    descripcion:
      "Proyectos de Supabase: consultas SQL, migraciones, edge functions y logs.",
    categoria: "desarrollo",
    icono: "database-zap",
    servidor: {
      name: "supabase",
      description: "Gestión de proyectos Supabase.",
      transport: stdio("npx", ["-y", "@supabase/mcp-server-supabase@latest"], {
        SUPABASE_ACCESS_TOKEN: "SUPABASE_ACCESS_TOKEN",
      }),
    },
    envRequeridas: [
      { ref: "SUPABASE_ACCESS_TOKEN", descripcion: "Personal access token de Supabase.", obligatoria: true },
    ],
    docsUrl: "https://github.com/supabase-community/supabase-mcp",
  },
  {
    id: "n8n",
    nombre: "n8n",
    descripcion:
      "Crear, validar y ejecutar flujos de n8n: el agente arma automatizaciones sobre tu instancia.",
    categoria: "desarrollo",
    icono: "workflow",
    servidor: {
      name: "n8n",
      description: "Gestión de flujos de n8n.",
      transport: stdio("npx", ["-y", "n8n-mcp"], {
        N8N_API_URL: "N8N_API_URL",
        N8N_API_KEY: "N8N_API_KEY",
      }),
    },
    envRequeridas: [
      { ref: "N8N_API_URL", descripcion: "URL de la instancia de n8n.", obligatoria: true },
      { ref: "N8N_API_KEY", descripcion: "API key de n8n.", obligatoria: true },
    ],
    docsUrl: "https://github.com/czlonkowski/n8n-mcp",
  },
  // --- Web y búsqueda ------------------------------------------------------
  {
    id: "fetch",
    nombre: "Fetch",
    descripcion:
      "Trae el contenido de una URL y lo convierte a markdown legible para el agente. Sin API key.",
    categoria: "web",
    icono: "globe",
    servidor: {
      name: "fetch",
      description: "Descarga y limpieza de páginas web.",
      transport: stdio("uvx", ["mcp-server-fetch"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "brave-search",
    nombre: "Brave Search",
    descripcion: "Búsqueda web y local con la API de Brave.",
    categoria: "web",
    icono: "search",
    servidor: {
      name: "brave",
      description: "Búsqueda web de Brave.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-brave-search"], {
        BRAVE_API_KEY: "BRAVE_API_KEY",
      }),
    },
    envRequeridas: [
      { ref: "BRAVE_API_KEY", descripcion: "API key de Brave Search.", obligatoria: true },
    ],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search",
  },
  {
    id: "duckduckgo",
    nombre: "DuckDuckGo",
    descripcion: "Búsqueda web sin API key, con extracción del contenido de los resultados.",
    categoria: "web",
    icono: "search",
    servidor: {
      name: "duckduckgo",
      description: "Búsqueda web con DuckDuckGo.",
      transport: stdio("uvx", ["duckduckgo-mcp-server"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/nickclyde/duckduckgo-mcp-server",
  },
  {
    id: "tavily",
    nombre: "Tavily",
    descripcion:
      "Búsqueda pensada para agentes: resultados limpios con extracto y puntaje de relevancia.",
    categoria: "web",
    icono: "telescope",
    servidor: {
      name: "tavily",
      description: "Búsqueda con la API de Tavily.",
      transport: stdio("npx", ["-y", "tavily-mcp"], { TAVILY_API_KEY: "TAVILY_API_KEY" }),
    },
    envRequeridas: [
      { ref: "TAVILY_API_KEY", descripcion: "API key de Tavily.", obligatoria: true },
    ],
    docsUrl: "https://github.com/tavily-ai/tavily-mcp",
  },
  {
    id: "firecrawl",
    nombre: "Firecrawl",
    descripcion:
      "Scraping serio: rastrea sitios enteros, extrae datos estructurados y devuelve markdown.",
    categoria: "web",
    icono: "flame",
    servidor: {
      name: "firecrawl",
      description: "Scraping y crawling con Firecrawl.",
      transport: stdio("npx", ["-y", "firecrawl-mcp"], {
        FIRECRAWL_API_KEY: "FIRECRAWL_API_KEY",
      }),
    },
    envRequeridas: [
      { ref: "FIRECRAWL_API_KEY", descripcion: "API key de Firecrawl.", obligatoria: true },
    ],
    docsUrl: "https://github.com/mendableai/firecrawl-mcp-server",
  },
  {
    id: "exa",
    nombre: "Exa",
    descripcion: "Búsqueda semántica sobre la web, con recuperación del contenido completo.",
    categoria: "web",
    icono: "sparkles",
    servidor: {
      name: "exa",
      description: "Búsqueda semántica de Exa.",
      transport: stdio("npx", ["-y", "exa-mcp-server"], { EXA_API_KEY: "EXA_API_KEY" }),
    },
    envRequeridas: [{ ref: "EXA_API_KEY", descripcion: "API key de Exa.", obligatoria: true }],
    docsUrl: "https://github.com/exa-labs/exa-mcp-server",
  },
  {
    id: "context7",
    nombre: "Context7",
    descripcion:
      "Documentación al día de librerías y frameworks, lista para pegar en el contexto del agente que programa.",
    categoria: "conocimiento",
    icono: "book-open",
    servidor: {
      name: "context7",
      description: "Documentación de librerías al día.",
      transport: stdio("npx", ["-y", "@upstash/context7-mcp"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/upstash/context7",
  },
  {
    id: "youtube-transcript",
    nombre: "Transcripciones de YouTube",
    descripcion: "La transcripción de un video de YouTube como texto, para citarla o resumirla.",
    categoria: "web",
    icono: "youtube",
    servidor: {
      name: "youtube",
      description: "Transcripciones de videos de YouTube.",
      transport: stdio("npx", ["-y", "@kimtaeyoon83/mcp-server-youtube-transcript"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/kimtaeyoon83/mcp-server-youtube-transcript",
  },
  // --- Navegador -----------------------------------------------------------
  {
    id: "playwright",
    nombre: "Playwright",
    descripcion:
      "Automatización de navegador de Microsoft: navegar, click, formularios y capturas sobre un árbol de accesibilidad, sin visión.",
    categoria: "navegador",
    icono: "app-window",
    servidor: {
      name: "playwright",
      description: "Automatización de navegador con Playwright.",
      transport: stdio("npx", ["-y", "@playwright/mcp@latest"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "puppeteer",
    nombre: "Puppeteer",
    descripcion: "Automatización de Chrome: navegación, capturas y ejecución de JavaScript.",
    categoria: "navegador",
    icono: "chrome",
    servidor: {
      name: "puppeteer",
      description: "Automatización de Chrome con Puppeteer.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-puppeteer"]),
    },
    envRequeridas: [],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer",
  },
  // --- Datos ---------------------------------------------------------------
  {
    id: "sqlite",
    nombre: "SQLite",
    descripcion:
      "Consultas SQL sobre una base SQLite local (data/mcp-sqlite.db). Ideal para que un análisis deje datos consultables.",
    categoria: "datos",
    icono: "database",
    servidor: {
      name: "sqlite",
      description: "Base SQLite local para los agentes.",
      transport: stdio("uvx", ["mcp-server-sqlite", "--db-path", "data/mcp-sqlite.db"]),
    },
    envRequeridas: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite",
  },
  {
    id: "airtable",
    nombre: "Airtable",
    descripcion: "Leer y escribir bases de Airtable: tablas, registros y vistas.",
    categoria: "datos",
    icono: "table",
    servidor: {
      name: "airtable",
      description: "Bases de Airtable.",
      transport: stdio("npx", ["-y", "airtable-mcp-server"], {
        AIRTABLE_API_KEY: "AIRTABLE_API_KEY",
      }),
    },
    envRequeridas: [
      { ref: "AIRTABLE_API_KEY", descripcion: "Personal access token de Airtable.", obligatoria: true },
    ],
    docsUrl: "https://github.com/domdomegg/airtable-mcp-server",
  },
  {
    id: "stripe",
    nombre: "Stripe",
    descripcion: "Clientes, pagos, facturas y suscripciones de una cuenta de Stripe.",
    categoria: "datos",
    icono: "credit-card",
    servidor: {
      name: "stripe",
      description: "API de Stripe.",
      transport: stdio("npx", ["-y", "@stripe/mcp", "--tools=all"], {
        STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY",
      }),
    },
    envRequeridas: [
      { ref: "STRIPE_SECRET_KEY", descripcion: "Clave secreta de la API de Stripe.", obligatoria: true },
    ],
    docsUrl: "https://github.com/stripe/agent-toolkit",
  },
  // --- Productividad y comunicación ---------------------------------------
  {
    id: "slack",
    nombre: "Slack",
    descripcion: "Leer y escribir en canales de Slack: mensajes, hilos y reacciones.",
    categoria: "comunicacion",
    icono: "slack",
    servidor: {
      name: "slack",
      description: "Canales y mensajes de Slack.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-slack"], {
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        SLACK_TEAM_ID: "SLACK_TEAM_ID",
      }),
    },
    envRequeridas: [
      { ref: "SLACK_BOT_TOKEN", descripcion: "Bot token (xoxb-…).", obligatoria: true },
      { ref: "SLACK_TEAM_ID", descripcion: "Id del workspace (T…).", obligatoria: true },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack",
  },
  {
    id: "notion",
    nombre: "Notion",
    descripcion: "Páginas y bases de datos de Notion: buscar, leer y escribir.",
    categoria: "productividad",
    icono: "notebook-text",
    servidor: {
      name: "notion",
      description: "Espacio de trabajo de Notion.",
      transport: stdio("npx", ["-y", "@notionhq/notion-mcp-server"], {
        NOTION_TOKEN: "NOTION_TOKEN",
      }),
    },
    envRequeridas: [
      { ref: "NOTION_TOKEN", descripcion: "Token de integración interna de Notion.", obligatoria: true },
    ],
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "google-maps",
    nombre: "Google Maps",
    descripcion: "Geocodificación, búsqueda de lugares, distancias y direcciones.",
    categoria: "productividad",
    icono: "map-pin",
    servidor: {
      name: "maps",
      description: "API de Google Maps.",
      transport: stdio("npx", ["-y", "@modelcontextprotocol/server-google-maps"], {
        GOOGLE_MAPS_API_KEY: "GOOGLE_MAPS_API_KEY",
      }),
    },
    envRequeridas: [
      { ref: "GOOGLE_MAPS_API_KEY", descripcion: "API key de Google Maps.", obligatoria: true },
    ],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/google-maps",
  },
];

/** Búsqueda por id, para el endpoint de instalación. */
export function articuloDeTienda(id: string): ArticuloDeTienda | null {
  return CATALOGO_MCP.find((articulo) => articulo.id === id) ?? null;
}
