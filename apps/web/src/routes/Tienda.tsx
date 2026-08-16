import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { icons, CircleCheck, ExternalLink, KeyRound, Search } from "lucide-react";
import type { CategoriaDeTienda } from "@orq/shared";
import { api, type ArticuloDeTiendaConEstado, type CompanyBundle } from "../api.js";
import { Badge, Button, Empty, Panel, Skeleton, inputClass, useToast } from "../ui/index.js";

/**
 * La tienda de servidores MCP, a pantalla completa.
 *
 * Es el catálogo curado del repo dispuesto como marketplace: por categoría,
 * con búsqueda, credenciales requeridas a la vista e instalación de un click.
 * Instalar hace el ciclo entero del lado del servidor —alta, handshake,
 * descubrimiento— y acá se cuenta el resultado con un toast: "conectado, N
 * herramientas", o el aviso de qué variable falta en el .env.
 */

const CATEGORIA: Record<CategoriaDeTienda, string> = {
  archivos: "Archivos",
  desarrollo: "Desarrollo",
  web: "Web y búsqueda",
  datos: "Datos",
  productividad: "Productividad",
  navegador: "Navegador",
  comunicacion: "Comunicación",
  conocimiento: "Conocimiento",
};

/** "folder-open" → icono de Lucide. Uno que no exista degrada al genérico. */
function IconoDe({ nombre }: { nombre: string }) {
  const pascal = nombre
    .split("-")
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
    .join("");
  const Icono = (icons as Record<string, (typeof icons)[keyof typeof icons]>)[pascal] ?? Search;
  return <Icono className="size-5" aria-hidden />;
}

export function Tienda({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const avisar = useToast();
  const [filtro, setFiltro] = useState("");

  const catalogo = useQuery({
    queryKey: ["tienda-mcp", companyId],
    queryFn: () => api.tiendaMcp(companyId),
  });

  const instalar = useMutation({
    mutationFn: (articuloId: string) => api.instalarDeTienda(companyId, articuloId),
    onSuccess: (data, articuloId) => {
      const nombre = catalogo.data?.find((a) => a.id === articuloId)?.nombre ?? articuloId;
      if (data.instalados.length > 0) {
        avisar(`${nombre} conectado: ${data.toolCount} herramientas descubiertas.`, "ok");
      }
      for (const aviso of data.avisos) avisar(aviso, "error");
      void queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-health", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["tools", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["tienda-mcp", companyId] });
    },
    onError: (error) =>
      avisar(error instanceof Error ? error.message : String(error), "error"),
  });

  const porCategoria = useMemo(() => {
    const texto = filtro.trim().toLowerCase();
    const visibles = (catalogo.data ?? []).filter(
      (articulo) =>
        !texto ||
        articulo.nombre.toLowerCase().includes(texto) ||
        articulo.descripcion.toLowerCase().includes(texto) ||
        articulo.categoria.includes(texto),
    );
    const grupos = new Map<CategoriaDeTienda, ArticuloDeTiendaConEstado[]>();
    for (const articulo of visibles) {
      const grupo = grupos.get(articulo.categoria) ?? [];
      grupo.push(articulo);
      grupos.set(articulo.categoria, grupo);
    }
    return grupos;
  }, [catalogo.data, filtro]);

  return (
    <div className="h-full min-h-0 overflow-auto p-2">
      <Panel
        title="Tienda de servidores MCP"
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
            <input
              value={filtro}
              onChange={(event) => setFiltro(event.target.value)}
              placeholder="buscar…"
              className="w-56 rounded border border-line bg-canvas py-1 pl-7 pr-2 text-xs text-ink outline-none focus:border-accent"
            />
          </div>
        }
      >
        <div className="space-y-5 p-3">
          <p className="text-xs text-ink-faint">
            Cada servidor le suma herramientas a este proyecto. Instalar conecta y descubre al
            toque; las credenciales van en el <code className="text-accent">.env</code> del
            servidor —acá nunca se pega un secreto—. Lo que no está en el catálogo se agrega
            pegando su JSON en la pestaña MCP.
          </p>

          {catalogo.isLoading && (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          )}

          {!catalogo.isLoading && porCategoria.size === 0 && (
            <Empty>Nada coincide con «{filtro}».</Empty>
          )}

          {[...porCategoria.entries()].map(([categoria, articulos]) => (
            <section key={categoria}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                {CATEGORIA[categoria]}
              </h3>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {articulos.map((articulo) => (
                  <article
                    key={articulo.id}
                    className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-line/80"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 text-ink">
                        <span className="rounded-md border border-line bg-surface p-1.5 text-accent">
                          <IconoDe nombre={articulo.icono} />
                        </span>
                        <div>
                          <h4 className="text-sm font-medium leading-tight">{articulo.nombre}</h4>
                          <a
                            href={articulo.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 text-[11px] text-ink-faint hover:text-accent"
                          >
                            documentación <ExternalLink className="size-3" aria-hidden />
                          </a>
                        </div>
                      </div>
                      {articulo.instalado && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ok">
                          <CircleCheck className="size-3.5" aria-hidden /> instalado
                        </span>
                      )}
                    </div>

                    <p className="flex-1 text-xs leading-relaxed text-ink-dim">
                      {articulo.descripcion}
                    </p>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {articulo.envRequeridas.map((entrada) => {
                        const falta = articulo.envFaltantes.includes(entrada.ref);
                        return (
                          <span key={entrada.ref} title={entrada.descripcion}>
                            <Badge tono={falta ? "warn" : "ok"}>
                              <KeyRound className="mr-1 size-3" aria-hidden />
                              {entrada.ref}
                              {falta ? " · falta" : ""}
                            </Badge>
                          </span>
                        );
                      })}
                      {articulo.envRequeridas.length === 0 && (
                        <Badge tono="neutro">sin credenciales</Badge>
                      )}
                      <div className="ml-auto">
                        {!articulo.instalado && (
                          <Button
                            variant="primary"
                            disabled={instalar.isPending}
                            onClick={() => instalar.mutate(articulo.id)}
                            title={
                              articulo.envFaltantes.length > 0
                                ? `Se instala igual, pero sin ${articulo.envFaltantes.join(", ")} no va a autenticar.`
                                : `Instala y conecta ${articulo.nombre}.`
                            }
                          >
                            {instalar.isPending && instalar.variables === articulo.id
                              ? "conectando…"
                              : "instalar"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Panel>
    </div>
  );
}
