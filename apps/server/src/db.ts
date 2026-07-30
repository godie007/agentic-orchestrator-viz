import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AgentRequest,
  ApprovalRequest,
  Artifact,
  Company,
  Department,
  LedgerEntry,
  Learning,
  McpServer,
  Message,
  Policy,
  Role,
  Run,
  Task,
  Tool,
  TraceEvent,
} from "@orq/shared";

/**
 * Persistencia.
 *
 * Cada entidad se guarda como un documento JSON con las columnas que hacen
 * falta para filtrar indexadas al costado. Para una herramienta local de un
 * solo usuario esto rinde de sobra y evita el desfase entre el esquema Zod
 * —que ya es la fuente de verdad— y un segundo esquema de tablas que habría
 * que mantener en paralelo.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  -- Los entregables son de la empresa, no de la corrida: con esta columna
  -- sobreviven a que se borre la corrida que los produjo.
  company_id TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data TEXT NOT NULL
);
-- Ámbito empresa, no corrida: es lo que hace que el conocimiento sobreviva.
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  data TEXT NOT NULL
);
-- La traza es lo que permite reproducir una corrida con el timeline, así que
-- se guarda con un número de secuencia: el timestamp no alcanza porque varios
-- eventos del mismo tick caen en el mismo milisegundo.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_departments_company ON departments(company_id);
CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id);
CREATE INDEX IF NOT EXISTS idx_policies_company ON policies(company_id);
CREATE INDEX IF NOT EXISTS idx_mcp_company ON mcp_servers(company_id);
CREATE INDEX IF NOT EXISTS idx_tools_company ON tools(company_id);
CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, tick);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_learnings_company ON learnings(company_id);
CREATE INDEX IF NOT EXISTS idx_requests_company ON agent_requests(company_id);
`;

export class Store {
  private db: Database.Database;

  constructor(databaseUrl: string) {
    const path = resolve(databaseUrl);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL permite que la UI lea mientras una corrida escribe sin bloquearse.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrarArtefactosAEmpresa();
  }

  /**
   * Da de alta `artifacts.company_id` en bases que ya existían y la completa.
   *
   * Es idempotente y barata: sin ella, borrar una corrida se llevaría los
   * entregables que produjo, que son el trabajo de la empresa.
   */
  private migrarArtefactosAEmpresa(): void {
    const columnas = this.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    if (!columnas.some((columna) => columna.name === "company_id")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN company_id TEXT");
    }
    this.db.exec(
      `UPDATE artifacts SET company_id = (SELECT r.company_id FROM runs r WHERE r.id = artifacts.run_id)
       WHERE company_id IS NULL`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_company ON artifacts(company_id)");
  }

  /** Tablas del esquema con su cantidad de filas, para inspeccionar la base. */
  tableCounts(): Array<{ name: string; rows: number }> {
    const tablas = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return tablas.map(({ name }) => ({
      name,
      // El nombre viene de `sqlite_master`, no de la entrada del usuario, así
      // que interpolarlo acá es seguro; SQLite no acepta parámetros para él.
      rows: (this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    }));
  }

  close(): void {
    this.db.close();
  }

  // --- Configuración de la empresa ----------------------------------------

  saveCompany(company: Company): void {
    this.db
      .prepare(
        `INSERT INTO companies (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(company.id, JSON.stringify(company), company.updatedAt);
  }

  getCompany(id: string): Company | null {
    return this.one<Company>("SELECT data FROM companies WHERE id = ?", id);
  }

  listCompanies(): Company[] {
    return this.many<Company>("SELECT data FROM companies ORDER BY updated_at DESC");
  }

  /**
   * Borra la empresa y **todo lo suyo**, corridas y entregables incluidos.
   *
   * Que un entregable sobreviva a que se borre su corrida es deliberado —para
   * eso existe `artifacts.company_id`—, pero no puede sobrevivir a que se borre
   * la empresa: ahí no queda nadie a quien pertenezca. Antes se dejaban
   * huérfanos y cada borrado desde la UI acumulaba basura invisible: medimos 10
   * entregables y 21 corridas apuntando a empresas inexistentes.
   */
  deleteCompany(id: string): void {
    const tables = ["departments", "roles", "policies", "mcp_servers", "tools", "learnings", "agent_requests"];
    const tx = this.db.transaction(() => {
      const runIds = this.db
        .prepare("SELECT id FROM runs WHERE json_extract(data, '$.companyId') = ?")
        .all(id) as Array<{ id: string }>;
      for (const { id: runId } of runIds) {
        for (const tabla of ["events", "messages", "tasks", "approvals", "ledger"]) {
          this.db.prepare(`DELETE FROM ${tabla} WHERE run_id = ?`).run(runId);
        }
      }
      this.db.prepare("DELETE FROM runs WHERE json_extract(data, '$.companyId') = ?").run(id);
      this.db.prepare("DELETE FROM artifacts WHERE company_id = ?").run(id);
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table} WHERE company_id = ?`).run(id);
      }
      this.db.prepare("DELETE FROM companies WHERE id = ?").run(id);
    });
    tx();
  }

  saveDepartment(department: Department): void {
    this.upsertScoped("departments", department.id, department.companyId, department);
  }
  listDepartments(companyId: string): Department[] {
    return this.many<Department>("SELECT data FROM departments WHERE company_id = ?", companyId);
  }
  deleteDepartment(id: string): void {
    this.db.prepare("DELETE FROM departments WHERE id = ?").run(id);
  }

  saveRole(role: Role): void {
    this.upsertScoped("roles", role.id, role.companyId, role);
  }
  listRoles(companyId: string): Role[] {
    return this.many<Role>("SELECT data FROM roles WHERE company_id = ?", companyId);
  }
  /**
   * Borrar un rol se lleva sus solicitudes. Una solicitud es un pedido de un
   * agente a la persona; si el agente ya no existe, nadie puede responderla y
   * aprobarla haría cosas absurdas —darle acceso a herramientas a un rol
   * borrado—. Va en el store y no en la ruta para que valga también para el
   * borrado en cascada de un departamento o de una empresa.
   */
  deleteRole(id: string): number {
    let solicitudes = 0;
    const tx = this.db.transaction(() => {
      solicitudes = this.db
        .prepare("DELETE FROM agent_requests WHERE json_extract(data, '$.requestedByRoleId') = ?")
        .run(id).changes;
      this.db.prepare("DELETE FROM roles WHERE id = ?").run(id);
    });
    tx();
    return solicitudes;
  }

  savePolicy(policy: Policy): void {
    this.upsertScoped("policies", policy.id, policy.companyId, policy);
  }
  listPolicies(companyId: string): Policy[] {
    return this.many<Policy>("SELECT data FROM policies WHERE company_id = ?", companyId);
  }
  deletePolicy(id: string): void {
    this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);
  }

  saveMcpServer(server: McpServer): void {
    this.upsertScoped("mcp_servers", server.id, server.companyId, server);
  }
  listMcpServers(companyId: string): McpServer[] {
    return this.many<McpServer>("SELECT data FROM mcp_servers WHERE company_id = ?", companyId);
  }
  deleteMcpServer(id: string): void {
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }

  saveTool(companyId: string, tool: Tool): void {
    this.db
      .prepare(
        `INSERT INTO tools (id, company_id, name, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, name = excluded.name`,
      )
      .run(tool.id, companyId, tool.name, JSON.stringify(tool));
  }
  listTools(companyId: string): Tool[] {
    return this.many<Tool>("SELECT data FROM tools WHERE company_id = ?", companyId);
  }
  deleteToolsByMcpServer(companyId: string, serverId: string): void {
    const tools = this.listTools(companyId).filter((tool) => tool.mcpServerId === serverId);
    const stmt = this.db.prepare("DELETE FROM tools WHERE id = ?");
    for (const tool of tools) stmt.run(tool.id);
  }

  // --- Corridas ------------------------------------------------------------

  saveRun(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, company_id, started_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(run.id, run.companyId, run.startedAt, JSON.stringify(run));
  }
  getRun(id: string): Run | null {
    return this.one<Run>("SELECT data FROM runs WHERE id = ?", id);
  }
  listRuns(companyId?: string): Run[] {
    return companyId
      ? this.many<Run>(
          "SELECT data FROM runs WHERE company_id = ? ORDER BY started_at DESC",
          companyId,
        )
      : this.many<Run>("SELECT data FROM runs ORDER BY started_at DESC LIMIT 100");
  }

  saveMessage(message: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, run_id, tick, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(message.id, message.runId, message.tick, JSON.stringify(message));
  }
  listMessages(runId: string): Message[] {
    return this.many<Message>(
      "SELECT data FROM messages WHERE run_id = ? ORDER BY tick, id",
      runId,
    );
  }

  saveTask(task: Task): void {
    this.upsertRunScoped("tasks", task.id, task.runId, task);
  }
  listTasks(runId: string): Task[] {
    return this.many<Task>("SELECT data FROM tasks WHERE run_id = ?", runId);
  }

  saveArtifact(artifact: Artifact, companyId?: string): void {
    this.upsertRunScoped("artifacts", artifact.id, artifact.runId, artifact);
    if (companyId) {
      this.db.prepare("UPDATE artifacts SET company_id = ? WHERE id = ?").run(companyId, artifact.id);
    }
  }
  listArtifacts(runId: string): Artifact[] {
    return this.many<Artifact>("SELECT data FROM artifacts WHERE run_id = ?", runId);
  }

  /**
   * Todo lo que la empresa produjo, de cualquier corrida.
   *
   * Los entregables se guardan por corrida, pero pertenecen a la empresa: un
   * área tiene que poder leer lo que otra escribió antes, y versionarlo en vez
   * de arrancar un documento nuevo. Se une por `runs` porque la tabla de
   * artefactos solo guarda `run_id`.
   */
  listArtifactsByCompany(companyId: string): Artifact[] {
    // Por `company_id` y no por join con `runs`: así siguen apareciendo aunque
    // se haya borrado la corrida que los creó.
    return this.many<Artifact>("SELECT data FROM artifacts WHERE company_id = ?", companyId);
  }

  /**
   * Borra una corrida y su rastro, conservando los entregables.
   *
   * Limpiar la lista de corridas no puede costarle a la empresa el trabajo que
   * produjo: los mensajes, tareas y eventos son el registro de *cómo* se llegó,
   * y eso sí se descarta.
   */
  deleteRun(runId: string): void {
    const tx = this.db.transaction(() => {
      for (const tabla of ["events", "messages", "tasks", "approvals", "ledger"]) {
        this.db.prepare(`DELETE FROM ${tabla} WHERE run_id = ?`).run(runId);
      }
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    });
    tx();
  }

  saveApproval(approval: ApprovalRequest): void {
    this.upsertRunScoped("approvals", approval.id, approval.runId, approval);
  }
  listApprovals(runId: string): ApprovalRequest[] {
    return this.many<ApprovalRequest>("SELECT data FROM approvals WHERE run_id = ?", runId);
  }

  saveLedgerEntry(entry: LedgerEntry): void {
    this.upsertRunScoped("ledger", entry.id, entry.runId, entry);
  }
  listLedger(runId: string): LedgerEntry[] {
    return this.many<LedgerEntry>("SELECT data FROM ledger WHERE run_id = ?", runId);
  }

  saveLearning(learning: Learning): void {
    this.upsertScoped("learnings", learning.id, learning.companyId, learning);
  }
  listLearnings(companyId: string): Learning[] {
    return this.many<Learning>("SELECT data FROM learnings WHERE company_id = ?", companyId);
  }
  deleteLearning(id: string): void {
    this.db.prepare("DELETE FROM learnings WHERE id = ?").run(id);
  }

  saveRequest(request: AgentRequest): void {
    this.upsertScoped("agent_requests", request.id, request.companyId, request);
  }
  listRequests(companyId: string): AgentRequest[] {
    return this.many<AgentRequest>(
      "SELECT data FROM agent_requests WHERE company_id = ?",
      companyId,
    );
  }
  getRequest(id: string): AgentRequest | null {
    return this.one<AgentRequest>("SELECT data FROM agent_requests WHERE id = ?", id);
  }

  saveEvent(event: TraceEvent): void {
    this.db
      .prepare("INSERT INTO events (id, run_id, tick, type, data) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.runId, event.tick, event.type, JSON.stringify(event));
  }

  /** Traza completa de una corrida, en orden de emisión: alimenta el replay. */
  listEvents(runId: string, sinceSeq = 0): TraceEvent[] {
    return this.many<TraceEvent>(
      "SELECT data FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      runId,
      sinceSeq,
    );
  }

  // --- Helpers -------------------------------------------------------------

  private upsertScoped(table: string, id: string, companyId: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (id, company_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(id, companyId, JSON.stringify(value));
  }

  private upsertRunScoped(table: string, id: string, runId: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (id, run_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(id, runId, JSON.stringify(value));
  }

  private one<T>(sql: string, ...params: unknown[]): T | null {
    const row = this.db.prepare(sql).get(...(params as [])) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  private many<T>(sql: string, ...params: unknown[]): T[] {
    const rows = this.db.prepare(sql).all(...(params as [])) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as T);
  }
}
