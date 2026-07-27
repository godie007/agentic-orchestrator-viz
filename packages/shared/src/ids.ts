const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * ID corto, legible y ordenable por tiempo: prefijo de tipo + timestamp en
 * base36 + aleatorio. Ordenar por ID ordena aproximadamente por creación, lo
 * que hace que los feeds y la traza salgan en orden sin un índice extra.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  let random = "";
  for (let i = 0; i < 6; i++) {
    random += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}_${time}${random}`;
}

export const ids = {
  company: () => newId("cmp"),
  department: () => newId("dep"),
  role: () => newId("rol"),
  tool: () => newId("tol"),
  mcpServer: () => newId("mcp"),
  policy: () => newId("pol"),
  run: () => newId("run"),
  message: () => newId("msg"),
  thread: () => newId("thr"),
  task: () => newId("tsk"),
  artifact: () => newId("art"),
  approval: () => newId("apv"),
  ledger: () => newId("led"),
  learning: () => newId("lrn"),
  request: () => newId("req"),
  event: () => newId("evt"),
  toolCall: () => newId("call"),
};
