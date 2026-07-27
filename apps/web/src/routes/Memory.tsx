import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CompanyBundle } from "../api.js";
import { Button, Empty, Field, Panel, inputClass } from "../lib/ui.js";

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
                      <p className="text-xs text-ink">{item.lesson}</p>
                      <div className="mt-0.5 flex gap-3 text-[10px] text-ink-faint">
                        <span>{nameOf(item.authorRoleId)}</span>
                        {item.timesConfirmed > 1 && (
                          <span className="text-ok">reafirmada ×{item.timesConfirmed}</span>
                        )}
                        <span>{new Date(item.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => remove.mutate(item.id)}
                      title="Olvidar esta lección"
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
    </div>
  );
}
