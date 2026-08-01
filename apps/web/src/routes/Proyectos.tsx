import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ResumenProyecto } from "../api.js";
import { Button, Empty, Field, Panel, Status, inputClass, peso, relativeTime } from "../lib/ui.js";

/**
 * Proyectos: la puerta de entrada.
 *
 * Cada proyecto es una empresa completa —agentes, departamentos, políticas,
 * herramientas, memoria y su propio directorio de salida— y adentro se sigue
 * hablando de empresa, que es la metáfora sobre la que está armado todo el
 * producto. Acá se elige con cuál trabajar, se crea uno nuevo y se da de baja.
 *
 * La ficha existe para poder decidir **sin entrar**: cuando hay cuatro
 * proyectos, la pregunta "¿cuál era el que no usé nunca?" se contesta mirando
 * agentes, corridas y peso en disco, no abriéndolos de a uno.
 */
export function Proyectos({
  activeId,
  onAbrir,
  onBorrado,
}: {
  activeId: string | null;
  /** Lo selecciona y lleva al diseñador: abrir un proyecto es entrar a él. */
  onAbrir: (id: string) => void;
  /** Para que quien elige el proyecto activo suelte el que se acaba de borrar. */
  onBorrado: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [creando, setCreando] = useState(false);
  const [borrando, setBorrando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const proyectos = useQuery({
    queryKey: ["proyectos"],
    queryFn: () => api.resumenProyectos(),
  });

  const refrescar = () => {
    void queryClient.invalidateQueries({ queryKey: ["proyectos"] });
    // La lista del selector del encabezado sale de otra consulta.
    void queryClient.invalidateQueries({ queryKey: ["companies"] });
  };

  const crear = useMutation({
    mutationFn: ({ name, mission }: { name: string; mission: string }) =>
      api.createCompany({
        name,
        mission,
        // El tier por defecto es `standard`: es el que sirve para los roles que
        // coordinan, y bajarlo después es más barato que descubrir por qué el
        // ejecutivo se fue por las ramas.
        defaultModel: {
          providerId: "openrouter",
          modelSlug: null,
          tier: "standard",
          temperature: null,
          maxOutputTokens: 4096,
        },
      }),
    onMutate: () => setError(null),
    onSuccess: (creado) => {
      setCreando(false);
      refrescar();
      // Un proyecto recién creado está vacío: lo único que se puede hacer con él
      // es armarle la organización, así que se entra directo.
      onAbrir(creado.id);
    },
    onError: (fallo: Error) => setError(fallo.message),
  });

  const borrar = useMutation({
    mutationFn: async (id: string) => {
      await api.deleteCompany(id);
      return id;
    },
    onMutate: () => setError(null),
    onSuccess: (id) => {
      setBorrando(null);
      refrescar();
      // Si era el proyecto activo, quien lo tiene seleccionado sigue apuntando a
      // un id muerto: sin esto, el resto de las pestañas quedan cargando algo
      // que ya no existe.
      onBorrado(id);
    },
    onError: (fallo: Error) => {
      setBorrando(null);
      setError(fallo.message);
    },
  });

  const lista = proyectos.data ?? [];

  return (
    <div className="h-full min-h-0 overflow-auto p-2">
      <Panel
        title={`Proyectos (${lista.length})`}
        actions={
          !creando && (
            <Button variant="primary" onClick={() => setCreando(true)}>
              + proyecto
            </Button>
          )
        }
      >
        <div className="space-y-2 p-2">
          {error && (
            <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          )}

          {creando && (
            <NuevoProyecto
              pendiente={crear.isPending}
              onCancelar={() => setCreando(false)}
              onCrear={(name, mission) => crear.mutate({ name, mission })}
            />
          )}

          {proyectos.isLoading ? (
            <Empty>Cargando…</Empty>
          ) : lista.length === 0 && !creando ? (
            <Empty>
              No hay ningún proyecto. Creá uno con <b>+ proyecto</b>, o ejecutá{" "}
              <code className="mx-1 text-accent">npm run db:seed</code> para traer el de
              ejemplo.
            </Empty>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {lista.map((proyecto) => (
                <Tarjeta
                  key={proyecto.id}
                  proyecto={proyecto}
                  activo={proyecto.id === activeId}
                  confirmando={borrando === proyecto.id}
                  trabajando={borrar.isPending}
                  onAbrir={() => onAbrir(proyecto.id)}
                  onPedirBorrar={() => {
                    setError(null);
                    setBorrando(proyecto.id);
                  }}
                  onCancelar={() => setBorrando(null)}
                  onConfirmar={() => borrar.mutate(proyecto.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Alta: sólo el nombre y la misión. El resto se edita adentro. */
function NuevoProyecto({
  onCrear,
  onCancelar,
  pendiente,
}: {
  onCrear: (name: string, mission: string) => void;
  onCancelar: () => void;
  pendiente: boolean;
}) {
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");

  return (
    <form
      className="space-y-2 rounded border border-accent/40 bg-accent/5 p-3"
      onSubmit={(evento) => {
        evento.preventDefault();
        if (name.trim()) onCrear(name.trim(), mission.trim());
      }}
    >
      <Field label="Nombre" hint="Cómo se llama la empresa que vas a modelar.">
        <input
          autoFocus
          className={inputClass}
          value={name}
          onChange={(evento) => setName(evento.target.value)}
          placeholder="Codytion S.A."
        />
      </Field>
      <Field
        label="Misión"
        hint="Qué hace, en una frase. Se puede completar después; el contexto de negocio se carga adentro."
      >
        <input
          className={inputClass}
          value={mission}
          onChange={(evento) => setMission(evento.target.value)}
          placeholder="Diseñamos software a medida para empresas medianas."
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={pendiente || !name.trim()}>
          {pendiente ? "creando…" : "crear y abrir"}
        </Button>
        <Button variant="ghost" onClick={onCancelar}>
          cancelar
        </Button>
        <span className="text-[11px] text-ink-faint">
          Nace vacío pero con sus herramientas listas para asignar.
        </span>
      </div>
    </form>
  );
}

/** La ficha de un proyecto: qué tiene, y si está trabajando ahora mismo. */
function Tarjeta({
  proyecto,
  activo,
  confirmando,
  trabajando,
  onAbrir,
  onPedirBorrar,
  onCancelar,
  onConfirmar,
}: {
  proyecto: ResumenProyecto;
  activo: boolean;
  confirmando: boolean;
  trabajando: boolean;
  onAbrir: () => void;
  onPedirBorrar: () => void;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  return (
    <li
      className={`flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-3 ${
        activo ? "border-accent/50" : "border-line"
      }`}
    >
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{proyecto.name}</h3>
          <p className="line-clamp-2 text-[11px] leading-snug text-ink-faint">
            {proyecto.mission || "Sin misión declarada."}
          </p>
        </div>
        {proyecto.corridaViva ? (
          <Status value="running" label="en curso" />
        ) : (
          activo && <Status value="idle" label="abierto" />
        )}
      </header>

      <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
        <Dato etiqueta="agentes" valor={proyecto.roles} />
        <Dato etiqueta="áreas" valor={proyecto.departamentos} />
        <Dato etiqueta="misiones" valor={proyecto.misiones} />
        <Dato etiqueta="corridas" valor={proyecto.corridas} />
        <Dato etiqueta="entregables" valor={proyecto.entregables} />
        <Dato etiqueta="en disco" valor={peso(proyecto.disco.bytes)} />
      </dl>

      <p className="text-[10px] text-ink-faint">
        {proyecto.ultimaCorridaAt
          ? `Última corrida ${relativeTime(proyecto.ultimaCorridaAt)}.`
          : "Nunca corrió."}{" "}
        {proyecto.disco.archivos > 0 && `${proyecto.disco.archivos} archivo(s) de salida.`}
      </p>

      {confirmando ? (
        <div className="space-y-1.5 rounded border border-danger/40 bg-danger/10 p-2">
          <p className="text-[11px] text-danger">
            ¿Borrar <b>{proyecto.name}</b>? Se van sus agentes, corridas, entregables, memoria
            y su carpeta de salida ({peso(proyecto.disco.bytes)}). No se puede deshacer.
          </p>
          <div className="flex items-center gap-1.5">
            <Button variant="danger" disabled={trabajando} onClick={onConfirmar}>
              sí, borrar
            </Button>
            <Button variant="ghost" onClick={onCancelar}>
              cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-auto flex items-center gap-1.5">
          <Button variant={activo ? "default" : "primary"} onClick={onAbrir}>
            {activo ? "ir al diseñador" : "abrir"}
          </Button>
          <Button
            variant="danger"
            disabled={trabajando || proyecto.corridaViva}
            title={
              proyecto.corridaViva
                ? "Tiene una corrida en curso. Detenela antes de borrar el proyecto."
                : "Borra el proyecto entero: base, conexiones MCP y archivos."
            }
            onClick={onPedirBorrar}
          >
            borrar
          </Button>
        </div>
      )}
    </li>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: number | string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] text-ink-faint">{etiqueta}</dt>
      <dd className="truncate font-medium text-ink">{valor}</dd>
    </div>
  );
}
