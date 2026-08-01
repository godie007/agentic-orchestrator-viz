---
tags: [operación]
aliases: [Instalación, Arranque, Setup, Quickstart]
---

# Instalación y arranque

## Requisitos

| Requisito | Versión | Para qué |
|---|---|---|
| **Node** | ≥ 22 | todo |
| **npm** | el que trae Node | workspaces |
| **ffmpeg** | reciente, con libass | `export_video` y `musica:cama` |
| Al menos una API key de proveedor LLM | — | que los agentes piensen |
| Kokoro (opcional) | — | narración; sin él cae a `say` de macOS |

## Arranque rápido

```bash
npm install
cp .env.example .env          # completá al menos una API key
npm run db:seed               # crea la empresa de ejemplo "Codytion S.A."
npm run dev                   # servidor :3001 + UI :5173
```

Abrí <http://localhost:5173>. El **MCP Hub** ya muestra dos servidores MCP
conectados; en **Proceso en vivo** le das un encargo a la empresa y arranca.

## Verificar antes de gastar

```bash
npm run check:models    # qué modelo resuelve cada tier, con precio real
npm run check:llm       # una llamada real con tool-calling, por proveedor
npm test                # tests del motor y de las herramientas
```

> [!warning] Corré `check:llm` antes de una corrida larga
> Una cuenta sin crédito contesta **402 a todo**, y eso se ve como una corrida que
> muere en el tercer ciclo sin producir nada.

## Las dos empresas de ejemplo

```bash
npm run db:seed        # Codytion S.A. — consultora, 7 roles, propuesta comercial
npm run db:estudio     # Estudio Codytion — 4 roles, produce un video
```

El estudio arranca en tier `free` para poder probarse sin gastar;
`ORQ_SEED_TIER=standard npm run db:estudio` lo cambia. Ver
[[Empresas de ejemplo]].

## Preparar la producción audiovisual (opcional)

```bash
npm run musica:cama    # sintetiza dos camas en data/musica para arrancar
```

Y dejá el logo en `data/exports/<empresa>/marca/logo.png` — ruta fija, se sube
por la misma pestaña que todo lo demás.

Sin música, los videos salen en silencio y todo lo demás funciona igual. Ver
[[Música y narración]].

## Modos de desarrollo

```bash
npm run dev            # servidor + UI (concurrently)
npm run dev:server     # solo Fastify, con tsx watch
npm run dev:web        # solo Vite
```

Vite usa `strictPort: true` para que no se corra de puerto en silencio.

## Estructura de datos en disco

Todo lo que genera vive bajo `data/` (git-ignored):

```
data/
├── orquestador.db          SQLite
├── exports/<empresa>/      Word, PDF, video, deck, imágenes
└── musica/                 las pistas las dejás vos
```

## Problemas de arranque

| Síntoma | Solución |
|---|---|
| el servidor sirve código viejo | un proceso quedó tomando el 3001: `lsof -ti:3001 \| xargs kill -9`. `pkill -f` no siempre alcanza |
| "No hay ninguna empresa" en la UI | `npm run db:seed` |
| `PORT="..." no es un número positivo válido` | el entorno se valida al arrancar, a propósito: arreglá el `.env` |
| el video falla | falta ffmpeg, o falta libass en el build de ffmpeg |

Ver [[Diagnóstico de problemas]].

## Enlaces

- [[Variables de entorno]]
- [[Comandos]]
- [[Empresas de ejemplo]]
- [[Casos de uso]]
