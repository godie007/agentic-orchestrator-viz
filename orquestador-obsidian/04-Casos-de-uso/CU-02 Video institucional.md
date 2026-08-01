---
tags: [caso-de-uso]
aliases: [CU-02, Video institucional]
---

# CU-02 Video institucional

**Qué se quiere lograr:** que la empresa escriba un guion, lo revise, y lo filme
como un `.mp4` narrado con música — más un deck del mismo contenido.

## Configuración

```bash
npm run db:estudio          # el estudio audiovisual de Codytion
ORQ_SEED_TIER=standard npm run db:estudio   # con modelos pagos
```

Cuatro roles:

| Rol | Autoridad | Herramientas asignadas |
|---|---|---|
| **Valentina Ríos** — Directora de marca | `executive` | `read_artifact`, `list_artifacts`, `check_activity`, `list_output` |
| **Julián Prieto** — Guionista | `manager` | `write_artifact`, `read_artifact`, `list_artifacts`, `fetch_url` |
| **Mariana Losada** — Revisora de guion | `manager` | `read_artifact`, `list_artifacts` |
| **Nadia Bercovich** — Realizadora | `executor` | las de exportar: `export_video`, `export_slides`, … |

Tres políticas: **Un solo guion**, **Sólo lo que podemos sostener**, **Se revisa
antes de filmar**.

> [!info] Por qué el seed usa `free` por defecto
> Para que se pueda probar sin gastar. `ORQ_SEED_TIER=standard` lo cambia.

### La voz de la marca

En `Company.voz`:

```ts
{ unaSolaVoz: true, pronunciacion: { Codytion: "códishon" } }
```

Una sola voz porque **una pieza institucional la dice la empresa, no un elenco**.
Y la pronunciación se aplica sólo al sintetizador: escribir "codishon" en el
guion sería una falta de ortografía en pantalla. Ver [[Música y narración]].

### Lo que hay que dejar preparado

| Qué | Dónde | Si falta |
|---|---|---|
| logo | `data/exports/<empresa>/marca/logo.png` | el video sale sin logo |
| música | `data/musica/` — o `npm run musica:cama` | **se filma en silencio** |
| Kokoro | `ORQ_KOKORO_HOME` o `~/.cache/` | cae a `say` de macOS |
| key de imágenes | `GOOGLE_API_KEY` / `OPENAI_API_KEY` / `NVIDIA_API_KEY` | `generar_imagen` **no se registra**, y `![...](generar)` vuelve como aviso |

## El recorrido

### 1. El encargo
> "Armá un video institucional de dos minutos sobre cómo trabajamos."

### 2. El guion
Julián escribe con `write_artifact` un markdown que es una línea de tiempo:

```markdown
# Cómo trabajamos en Codytion

## :objetivo: Entendemos el negocio antes que el sistema

Antes de escribir una línea, nos sentamos con quien opera todos los días.

- Entrevistas en el lugar de trabajo
- Un mapa de cómo se mueve el dato hoy

![de dónde sale el dato y a dónde llega](visual:flujo)

## :equipo: Un equipo chico que responde

**Sofía:** ¿Y si cambia el alcance a mitad de camino?
**Diego:** Lo vemos en la revisión de la semana y lo repriorizamos juntos.
```

Ver [[Producción audiovisual]] para cómo se lee cada elemento.

### 3. La revisión
Mariana lee el guion y devuelve correcciones. La política **"Se revisa antes de
filmar"** hace que la tarea pase por `in_review` — una etapa **visible** en el
tablero, no un mensaje suelto. Ver [[Modelo de dominio]].

### 4. Filmar
Nadia llama:

```
export_video(key: "guion-institucional", folder: "institucional")
export_slides(key: "guion-institucional", folder: "institucional")
```

Las dos salidas salen del mismo `parseGuion`, así que **no pueden decir cosas
distintas**.

### 5. Revisar
Pestaña **Salida**: el `.mp4` se reproduce ahí mismo; el `.html` del deck se
dibuja en un iframe con `sandbox` vacío.

## Qué mirar

- **El diálogo suena a dos personas**, no a una leyendo los nombres de las otras.
  Si suena a lo segundo, el guion escribió el diálogo con renglones en blanco.
- **Los íconos escalan sin pixelarse** y toman el color del estilo: son trazos
  vectoriales, no imágenes.
- **La cama se aparta cuando alguien habla** (`sidechaincompress`).
- **El logo está quieto y chico**, sin acercamiento ni recorte.
- **En el deck**, lo que en el video era voz en off es la nota al pie de la
  lámina. Y la firma es la empresa, no el rol que lo produjo.

## Qué puede salir mal

| Síntoma | Causa |
|---|---|
| las cuatro intervenciones las dice de corrido el primero | el diálogo se escribió con renglones en blanco entre líneas |
| el video dice ":objetivo:" en el medio | la marca de ícono quedó **sola en su renglón** — es un párrafo, y un párrafo es voz en off |
| la portada dice "(v4)" y el título real es una placa del medio | encabezado de documento arriba del guion |
| la cama suena a cinta acelerada | el `aresample` quedó antes de `loudnorm` |
| la persona del visual tiene el teléfono flotando | se movió la figura sin mover los props |
| el video sale en silencio con música en la carpeta | pistas en subcarpetas y un `readdir` a secas — ya corregido, pero verificá `MUSICA_DIR` |

Ver [[Producción audiovisual]], [[Íconos y visuales vectoriales]] y
[[Música y narración]] para el detalle de cada una.

## Variante: programarlo

Convertí el encargo en una [[Misiones programadas|misión]] semanal que avise por
correo. Ver [[CU-03 Misión semanal con aprobación humana]].
