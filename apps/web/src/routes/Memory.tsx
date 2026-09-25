import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Learning } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { Button, Empty, Field, Panel, inputClass } from "../lib/ui.js";
import { Modal } from "../ui/index.js";

/**
 * Memoria de la empresa.
 *
 * Lo único que sobrevive a una corrida. Es lo que evita volver a pagar por
 * conocimiento que la empresa ya tiene: todo lo que está acá entra en el prompt
 * de cada agente, así que no se re-deriva a fuerza de mensajes.
 *
 * Se puede editar a mano: sembrar la memoria antes de la primera corrida es la
 * forma más barata de que la empresa arranque sabiendo algo.
 */
export function Memory({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const [topic, setTopic] = useState("");
  const [lesson, setLesson] = useState("");
  /** Lección abierta en el editor, o null. */
  const [editando, setEditando] = useState<Learning | null>(null);

  const learnings = useQuery({
    queryKey: ["learnings", companyId],
    queryFn: () => api.learnings(companyId),
    refetchInterval: 5000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["learnings", companyId] });

  const add = useMutation({
    mutationFn: () => api.addLearning(companyId, topic.trim(), lesson.trim()),
    onSuccess: () => {
      setTopic("");
      setLesson("");
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLearning(companyId, id),
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof api.updateLearning>[2] }) =>
      api.updateLearning(companyId, input.id, input.patch),
    onSuccess: () => {
      setEditando(null);
      void invalidate();
    },
  });

  const items = learnings.data ?? [];
  const byTopic = new Map<string, typeof items>();
  for (const item of items) {
    byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item]);
  }

  const nameOf = (roleId: string | null): string =>
    company.roles.find((role) => role.id === roleId)?.name ?? "cargada a mano";

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_360px] gap-2 p-2">
      <Panel
        title={`Lo que la empresa aprendió (${items.length})`}
        actions={
          <span className="text-[10px] normal-case text-ink-faint">
            entra en el prompt de todos los agentes
          </span>
        }
      >
        {items.length === 0 ? (
          <Empty>
            La memoria está vacía. Los agentes la llenan con <code>record_lesson</code> durante
            una corrida, o podés sembrarla vos acá al costado.
          </Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {[...byTopic.entries()].map(([group, lessons]) => (
              <li key={group}>
                <div className="bg-surface-2/60 px-3 py-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
                  {group}
                </div>
                {lessons.map((item) => (
                  <div key={item.id} className="group flex items-start gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p
                        className={
                          item.estado === "refutada"
                            ? "text-xs text-ink-faint line-through"
                            : "text-xs text-ink"
                        }
                      >
                        {item.estado === "cuestionada" && (
                          <span className="mr-1 text-warn" title="Sin verificar">(?)</span>
                        )}
                        {item.lesson}
                      </p>
                      {item.estado === "refutada" && item.refutacion && (
                        <p className="mt-0.5 text-[10px] text-danger">
                          Refutada: {item.refutacion.motivo}
                        </p>
                      )}
                      {item.evidencia && item.estado !== "refutada" && (
                        <p className="mt-0.5 text-[10px] text-ink-faint italic">
                          Evidencia: {item.evidencia}
                        </p>
                      )}
                      <div className="mt-0.5 flex gap-3 text-[10px] text-ink-faint">
                        <span>{nameOf(item.authorRoleId)}</span>
                        {item.timesConfirmed > 1 && (
                          <span className="text-ok">reafirmada ×{item.timesConfirmed}</span>
                        )}
                        <span>{new Date(item.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => setEditando(item)}
                      title="Editar, refutar o restaurar esta lección"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-2"
                    >
                      editar
                    </button>
                    <button
                      onClick={() => remove.mutate(item.id)}
                      title="Olvidar esta lección (para marcarla falsa sin perderla, usá editar → refutar)"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-danger/20 hover:text-danger"
                    >
                      olvidar
                    </button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Enseñarle algo">
        <form
          className="space-y-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (topic.trim() && lesson.trim()) add.mutate();
          }}
        >
          <Field label="Tema" hint="Agrupador corto: precios, estimación, cliente:retail…">
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className={inputClass}
              placeholder="precios"
            />
          </Field>
          <Field
            label="Lección"
            hint="Autocontenida: alguien que no vio ninguna corrida tiene que poder aplicarla."
          >
            <textarea
              value={lesson}
              onChange={(event) => setLesson(event.target.value)}
              rows={5}
              className={inputClass}
              placeholder="La tarifa estándar de desarrollo senior es US$45/hora; por debajo de US$38 el proyecto no llega al margen objetivo."
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={!topic.trim() || !lesson.trim() || add.isPending}
          >
            {add.isPending ? "guardando…" : "guardar"}
          </Button>
          {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
        </form>
      </Panel>

      {editando && (
        <EditorDeLeccion
          leccion={editando}
          pendiente={update.isPending}
          error={update.error?.message ?? null}
          onCerrar={() => setEditando(null)}
          onGuardar={(patch) => update.mutate({ id: editando.id, patch })}
        />
      )}
    </div>
  );
}

/**
 * Editar, refutar o restaurar una lección.
 *
 * Refutar es la corrección de verdad: la lección deja de entrar al prompt
 * pero queda con su motivo — borrarla invita a re-aprender el mismo error.
 * Es una decisión humana a propósito: un agente que discrepa registra la
 * corrección con evidencia, y la tensión la resuelve quien mira esta pantalla.
 */
function EditorDeLeccion({
  leccion,
  pendiente,
  error,
  onCerrar,
  onGuardar,
}: {
  leccion: Learning;
  pendiente: boolean;
  error: string | null;
  onCerrar: () => void;
  onGuardar: (patch: {
    topic?: string;
    lesson?: string;
    estado?: "activa" | "cuestionada" | "refutada";
    motivoDeRefutacion?: string;
  }) => void;
}) {
  const [topic, setTopic] = useState(leccion.topic);
  const [lesson, setLesson] = useState(leccion.lesson);
  const [motivo, setMotivo] = useState("");
  const refutada = leccion.estado === "refutada";

  return (
    <Modal abierto titulo={`Editar lección — ${leccion.topic}`} onCerrar={onCerrar}>
      <div className="space-y-3">
        <Field label="Tema">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Lección">
          <textarea
            value={lesson}
            onChange={(e) => setLesson(e.target.value)}
            rows={5}
            className={inputClass}
          />
        </Field>
        {!refutada && (
          <Field
            label="Refutar (opcional)"
            hint="Si la lección es falsa, escribí por qué: deja de entrar al prompt pero queda el registro."
          >
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              className={inputClass}
              placeholder="Ej: el índice de lectura mostraba secciones duplicadas que el documento no tiene."
            />
          </Field>
        )}
        {refutada && leccion.refutacion && (
          <p className="text-xs text-danger">Refutada: {leccion.refutacion.motivo}</p>
        )}
        <div className="flex items-center justify-end gap-2">
          {refutada && (
            <Button
              onClick={() => onGuardar({ estado: "activa" })}
              disabled={pendiente}
              title="Vuelve a entrar al prompt de las corridas."
            >
              restaurar
            </Button>
          )}
          {!refutada && motivo.trim() && (
            <Button
              variant="danger"
              onClick={() => onGuardar({ estado: "refutada", motivoDeRefutacion: motivo.trim() })}
              disabled={pendiente}
            >
              refutar
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => onGuardar({ topic: topic.trim(), lesson: lesson.trim() })}
            disabled={pendiente || !topic.trim() || !lesson.trim()}
          >
            {pendiente ? "guardando…" : "guardar cambios"}
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
