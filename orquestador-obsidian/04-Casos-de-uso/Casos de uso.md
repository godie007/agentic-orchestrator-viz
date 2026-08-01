---
tags: [caso-de-uso, moc]
aliases: [Casos de uso, CU]
---

# Casos de uso

Recorridos completos, de punta a punta. Cada uno nombra qué hace falta configurar
y qué se ve en pantalla.

| # | Caso | Empresa | Qué demuestra |
|---|---|---|---|
| [[CU-01 Propuesta comercial]] | un encargo comercial descompuesto y delegado a cuatro direcciones | Codytion S.A. (`db:seed`) | coordinación, jerarquía, políticas con `gate`, entregable en Word |
| [[CU-02 Video institucional]] | de un guion en markdown a un `.mp4` narrado y un deck | Estudio Codytion (`db:estudio`) | habilidades audiovisuales, revisión antes de filmar |
| [[CU-03 Misión semanal con aprobación humana]] | un encargo que se dispara solo, avisa por correo y espera | cualquiera | misiones, correo, publicar |
| [[CU-04 Control de calidad entre agentes]] | un revisor que contrasta el entregable contra su fuente | Codytion S.A. | `check_activity`, `in_review`, falsos positivos |
| [[CU-05 Conectar un servidor MCP]] | sumar herramientas externas y dárselas a un rol | cualquiera | MCP Hub, matriz de accesos, probador |

## Antes de cualquiera

```bash
npm install
cp .env.example .env      # al menos una API key
npm run check:llm         # ¿el proveedor contesta?
npm run dev               # servidor :3001 + UI :5173
```

Ver [[Instalación y arranque]].

> [!warning] Corré `check:llm` antes de una corrida larga
> Una cuenta sin crédito contesta **402 a todo**, y eso se ve como una corrida que
> muere en el tercer ciclo sin producir nada. Ver [[Diagnóstico de problemas]].

## Cómo leer estos casos

Cada uno tiene la misma estructura:

1. **Qué se quiere lograr** — en una frase.
2. **Configuración** — empresa, roles, herramientas, políticas.
3. **El recorrido** — paso a paso, con lo que se ve en pantalla.
4. **Qué mirar** — dónde se nota que el sistema hizo lo correcto.
5. **Qué puede salir mal** — con el enlace al diagnóstico.

## Enlaces

- [[Empresas de ejemplo]] — las dos empresas sembradas
- [[Comandos]]
- [[Diagnóstico de problemas]]
