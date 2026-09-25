import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { argvATexto, tokenizar, type Argv } from "@orq/shared";
import { api, type ComandosEditables, type RepoConSesion } from "../../api.js";
import { Button, ConfirmDialog, Field, NombreEditable, Tabs, inputClass, useToast } from "../../ui/index.js";
import { Vista } from "./ControlDeCodigo.js";

/**
 * La vista "Repositorio" del IDE: cargar código, qué comandos se pueden correr
 * y sacar un repo del proyecto. Es la configuración; el trabajo está en las
 * otras vistas.
 */

export function Repositorio({
  companyId,
  item,
  onCargado,
}: {
  companyId: string;
  item: RepoConSesion | null;
  onCargado: (repoId: string) => void;
}) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const [borrar, setBorrar] = useState(false);
  const eliminar = useMutation({
    mutationFn: () => api.eliminarRepo(item!.repo.id),
    onSuccess: ({ respaldo }) => {
      setBorrar(false);
      void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
      avisar(
        respaldo
          ? `Se sacó el repo. El trabajo sin integrar quedó respaldado en Salida → ${respaldo} (y su .patch).`
          : "Se sacó el repo del proyecto. Tu carpeta original sigue igual.",
        "ok",
      );
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  return (
    <Vista titulo="Repositorio">
      <div className="space-y-4 px-3 pb-6">
        {item && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[12px]">
              <dt className="text-ink-faint">Nombre</dt>
              <dd className="flex min-w-0">
                <NombreEditable
                  valor={item.repo.nombre}
                  etiqueta="Renombrar repo"
                  className="font-medium text-ink"
                  onGuardar={async (nombre) => {
                    await api.renombrarRepo(item.repo.id, nombre);
                    await queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
                  }}
                />
              </dd>
              <dt className="text-ink-faint">Origen</dt>
              <dd className="min-w-0 truncate font-mono text-[11px]" title={item.repo.origen.tipo === "local" ? item.repo.origen.ruta : item.repo.origen.tipo === "git" ? item.repo.origen.url : "creado por la empresa"}>
                {item.repo.origen.tipo === "local" ? item.repo.origen.ruta : item.repo.origen.tipo === "git" ? item.repo.origen.url : "creado por la empresa"}
              </dd>
              <dt className="text-ink-faint">Rama base</dt>
              <dd className="font-mono text-[11px]">{item.repo.ramaBase}</dd>
              <dt className="text-ink-faint">Copia</dt>
              <dd className="min-w-0 truncate font-mono text-[11px] text-ink-dim" title={item.clon}>{item.clon}</dd>
            </dl>
            <EditorDeComandos key={item.repo.id + item.repo.updatedAt} repo={item} companyId={companyId} />
            <button
              type="button"
              onClick={() => setBorrar(true)}
              className="flex items-center gap-1.5 text-[12px] text-ink-faint hover:text-danger"
            >
              <Trash2 className="size-3.5" aria-hidden /> Sacar este repo del proyecto
            </button>
            <hr className="border-line" />
          </>
        )}
        <CargarRepo companyId={companyId} onCargado={onCargado} />
      </div>
      <ConfirmDialog
        abierto={borrar}
        titulo="Sacar el repo del proyecto"
        detalle="Se borran la copia de trabajo, las sesiones y sus ramas dentro del orquestador. Tu carpeta o repo original no se toca. Si la sesión tiene trabajo sin integrar, antes queda un respaldo (bundle de git y patch) en Salida → respaldos."
        confirmar="Sacar"
        pendiente={eliminar.isPending}
        onConfirmar={() => eliminar.mutate()}
        onCancelar={() => setBorrar(false)}
      />
    </Vista>
  );
}

function CargarRepo({ companyId, onCargado }: { companyId: string; onCargado: (id: string) => void }) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const [tipo, setTipo] = useState<"local" | "git">("local");
  const [origen, setOrigen] = useState("");
  const [nombre, setNombre] = useState("");
  const [rama, setRama] = useState("");
  const [conCambios, setConCambios] = useState(false);
  const [resultado, setResultado] = useState<{ avisos: string[]; sugeridos: ComandosEditables; repoId: string } | null>(
    null,
  );

  const cargar = useMutation({
    mutationFn: () =>
      api.cargarRepo(companyId, {
        origen: tipo === "local" ? { tipo: "local", ruta: origen.trim() } : { tipo: "git", url: origen.trim() },
        ...(nombre.trim() ? { nombre: nombre.trim() } : {}),
        ...(rama.trim() ? { ramaBase: rama.trim() } : {}),
        ...(tipo === "local" && conCambios ? { incluirCambiosSinCommitear: true } : {}),
      }),
    onSuccess: (r) => {
      setResultado({ avisos: r.avisos, sugeridos: r.sugeridos, repoId: r.repo.id });
      setOrigen("");
      setNombre("");
      setRama("");
      void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
      onCargado(r.repo.id);
      avisar(`Se cargó ${r.repo.nombre}.`, "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const aplicarSugeridos = useMutation({
    mutationFn: () => api.actualizarComandos(resultado!.repoId, resultado!.sugeridos),
    onSuccess: () => {
      setResultado(null);
      void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
      avisar("Comandos permitidos.", "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">Cargar código</h3>
      <div className="space-y-3">
        <Tabs
          valor={tipo}
          opciones={[
            { id: "local", etiqueta: "Carpeta local" },
            { id: "git", etiqueta: "URL git" },
          ]}
          onCambiar={setTipo}
        />
        <Field
          label={tipo === "local" ? "Ruta" : "URL"}
          hint={
            tipo === "local"
              ? "Se clona (o se copia, si no tiene git). Tu carpeta no se toca hasta que integres."
              : "https o ssh, sin usuario ni token adentro: el acceso lo da tu configuración de git."
          }
        >
          <input
            className={inputClass}
            value={origen}
            onChange={(e) => setOrigen(e.target.value)}
            placeholder={tipo === "local" ? "~/workspace/mi-app" : "https://github.com/org/repo.git"}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Nombre (opcional)">
            <input className={inputClass} value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </Field>
          <Field label="Rama base (opcional)">
            <input className={inputClass} value={rama} onChange={(e) => setRama(e.target.value)} placeholder="la actual" />
          </Field>
        </div>
        {tipo === "local" && (
          <label className="flex items-center gap-2 text-xs text-ink-dim">
            <input type="checkbox" checked={conCambios} onChange={(e) => setConCambios(e.target.checked)} />
            Incluir mis cambios sin commitear (sólo archivos que git ya rastrea)
          </label>
        )}
        <Button variant="primary" onClick={() => cargar.mutate()} disabled={!origen.trim() || cargar.isPending}>
          {cargar.isPending ? "Cargando…" : "Cargar"}
        </Button>

        {resultado && (
          <div className="space-y-2 rounded border border-line bg-surface-2 p-2 text-xs">
            {resultado.avisos.map((aviso) => (
              <p key={aviso} className="text-warn">
                {aviso}
              </p>
            ))}
            {resultado.sugeridos.permitidos?.length || resultado.sugeridos.test ? (
              <>
                <p className="text-ink-dim">El repo parece usar estos comandos. No quedan permitidos hasta que lo confirmes:</p>
                <ul className="font-mono text-[11px] text-ink">
                  {resultado.sugeridos.preparar && <li>preparar: {argvATexto(resultado.sugeridos.preparar)}</li>}
                  {resultado.sugeridos.test && <li>tests: {argvATexto(resultado.sugeridos.test)}</li>}
                  {resultado.sugeridos.verificar && <li>verificar: {argvATexto(resultado.sugeridos.verificar)}</li>}
                  {(resultado.sugeridos.permitidos ?? []).map((c) => (
                    <li key={c.join(" ")}>permitir: {argvATexto(c)}</li>
                  ))}
                </ul>
                <Button onClick={() => aplicarSugeridos.mutate()} disabled={aplicarSugeridos.isPending}>
                  Permitir estos comandos
                </Button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function aLineas(comandos: readonly (readonly string[])[]): string {
  return comandos.map((c) => argvATexto(c)).join("\n");
}

function EditorDeComandos({ repo: item, companyId }: { repo: RepoConSesion; companyId: string }) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const { repo } = item;
  const [permitidos, setPermitidos] = useState(aLineas(repo.comandos.permitidos));
  const [preparar, setPreparar] = useState(repo.comandos.preparar ? argvATexto(repo.comandos.preparar) : "");
  const [test, setTest] = useState(repo.comandos.test ? argvATexto(repo.comandos.test) : "");
  const [verificar, setVerificar] = useState(repo.comandos.verificar ? argvATexto(repo.comandos.verificar) : "");
  const [sinAislamiento, setSinAislamiento] = useState(repo.comandos.sinAislamiento);
  const [error, setError] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: () => {
      const uno = (texto: string, campo: string): Argv | null => {
        if (!texto.trim()) return null;
        const t = tokenizar(texto);
        if (!t.ok) throw new Error(`${campo}: ${t.motivo}`);
        return t.argv;
      };
      const lista = permitidos
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => uno(l, `"${l}"`)!);
      return api.actualizarComandos(repo.id, {
        permitidos: lista,
        preparar: uno(preparar, "Preparar"),
        test: uno(test, "Tests"),
        verificar: uno(verificar, "Verificar"),
        sinAislamiento,
      });
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
      avisar("Comandos guardados.", "ok");
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">Comandos</h3>
        <Button variant="primary" onClick={() => guardar.mutate()} disabled={guardar.isPending}>
          Guardar
        </Button>
      </div>
      <div className="grid gap-3">
        <Field
          label="Permitidos (uno por línea)"
          hint="Un prefijo: 'npm test' permite 'npm test -- -t suma', no 'npm testx'. git status/diff/log siempre se permiten."
        >
          <textarea
            className={`${inputClass} min-h-28 font-mono text-[11px]`}
            value={permitidos}
            onChange={(e) => setPermitidos(e.target.value)}
            placeholder={"npm test\nnpm run typecheck"}
          />
        </Field>
        <div className="space-y-2">
          <Field label="Tests">
            <input className={`${inputClass} font-mono text-[11px]`} value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" />
          </Field>
          <Field label="Verificar">
            <input className={`${inputClass} font-mono text-[11px]`} value={verificar} onChange={(e) => setVerificar(e.target.value)} placeholder="npm run typecheck" />
          </Field>
          <Field label="Preparar el worktree" hint="Se corre a mano la primera vez; ej. npm ci.">
            <input className={`${inputClass} font-mono text-[11px]`} value={preparar} onChange={(e) => setPreparar(e.target.value)} placeholder="npm ci" />
          </Field>
        </div>
      </div>
      <label className="mt-3 flex items-start gap-2 text-xs text-ink-dim">
        <input type="checkbox" className="mt-0.5" checked={sinAislamiento} onChange={(e) => setSinAislamiento(e.target.checked)} />
        <span>
          <span className="font-medium text-warn">Correr sin aislamiento.</span> Sólo si esta máquina no tiene sandbox-exec o un
          comando lo necesita: sin aislamiento, los tests que escribe un agente corren como tu usuario, con acceso a todo lo tuyo.
        </span>
      </label>
      {repo.pendienteDeConfirmar && (
        <p className="mt-2 text-xs text-warn">Estos comandos vinieron importados. Revisalos y guardá para confirmarlos.</p>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

