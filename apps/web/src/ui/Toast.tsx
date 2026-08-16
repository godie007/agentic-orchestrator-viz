import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

/**
 * Avisos efímeros. Antes no había: el resultado de una acción se perdía o se
 * pintaba inline con markup distinto en cada pantalla. "Conectado, 12
 * herramientas" es exactamente la clase de cosa que un toast comunica bien.
 */

export type ClaseDeToast = "ok" | "error" | "info";

interface Toast {
  id: number;
  clase: ClaseDeToast;
  mensaje: string;
}

type Avisar = (mensaje: string, clase?: ClaseDeToast) => void;

const ToastContext = createContext<Avisar>(() => undefined);

export function useToast(): Avisar {
  return useContext(ToastContext);
}

const ICONO: Record<ClaseDeToast, typeof Info> = {
  ok: CheckCircle2,
  error: CircleAlert,
  info: Info,
};

const COLOR: Record<ClaseDeToast, string> = {
  ok: "border-ok/40 text-ok",
  error: "border-danger/40 text-danger",
  info: "border-line text-ink-dim",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const siguiente = useRef(1);

  const cerrar = useCallback((id: number) => {
    setToasts((actuales) => actuales.filter((toast) => toast.id !== id));
  }, []);

  const avisar = useCallback<Avisar>(
    (mensaje, clase = "info") => {
      const id = siguiente.current++;
      setToasts((actuales) => [...actuales.slice(-3), { id, clase, mensaje }]);
      // Un error se queda más: hay que poder leerlo.
      window.setTimeout(() => cerrar(id), clase === "error" ? 9000 : 5000);
    },
    [cerrar],
  );

  const valor = useMemo(() => avisar, [avisar]);

  return (
    <ToastContext.Provider value={valor}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => {
          const Icono = ICONO[toast.clase];
          return (
            <div
              key={toast.id}
              className={`toast-entrando pointer-events-auto flex max-w-lg items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-xs shadow-lg ${COLOR[toast.clase]}`}
              role="status"
            >
              <Icono className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="text-ink">{toast.mensaje}</span>
              <button
                type="button"
                onClick={() => cerrar(toast.id)}
                className="ml-1 shrink-0 text-ink-faint transition-colors hover:text-ink"
                title="Cerrar"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
