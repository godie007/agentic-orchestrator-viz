---
tags: [meta]
---

# Cómo navegar esta bóveda

Esta carpeta es una **bóveda de Obsidian**: abrila con `Archivo → Abrir bóveda →
Abrir carpeta como bóveda` apuntando a `orquestador-obsidian/`. Funciona igual
como carpeta de markdown en cualquier editor, pero perdés el grafo y los enlaces
`[[...]]` navegables.

## Estructura

```
orquestador-obsidian/
├── Inicio.md                  ← el MOC principal, empezá acá
├── 00-Meta/                   cómo se escribe y se lee esta documentación
├── 01-Producto/               qué es, para quién, en qué estado
├── 02-Arquitectura/           cómo está construido y por qué
│   └── ADR/                   decisiones con su contexto y su costo
├── 03-Capacidades/            qué sabe hacer el sistema
├── 04-Casos-de-uso/           recorridos completos de punta a punta
├── 05-Operación/              instalar, configurar, correr, diagnosticar
├── 06-Referencia/             tablas para consultar, no para leer
└── 07-Contribuir/             cómo extenderlo sin romper nada
```

## Los tres recorridos

**Recorrido de comprensión** (2 horas, para entender el sistema entero):
[[Visión del producto]] → [[Arquitectura general]] → [[Modelo de dominio]] →
[[Scheduler y ciclo de una corrida]] → [[Motor de agentes]] →
[[Observabilidad y trazas]] → [[Casos de uso]].

**Recorrido de operación** (30 minutos, para ponerlo a correr):
[[Instalación y arranque]] → [[Variables de entorno]] → [[Comandos]] →
[[Empresas de ejemplo]] → [[Diagnóstico de problemas]].

**Recorrido de contribución** (antes de la primera línea de código):
[[Invariantes de arquitectura]] → [[Trampas conocidas]] →
[[Guía de contribución]] → el how-to que corresponda en `07-Contribuir/`.

## Relación con los archivos del repo

Esta bóveda **no reemplaza** dos archivos que viven en la raíz del repositorio:

| Archivo | Qué cubre | Relación |
|---|---|---|
| `README.md` | pitch del producto y estado, orientado a quien lo evalúa | esta bóveda lo expande en [[Visión del producto]] y [[Estado del producto]] |
| `CLAUDE.md` | instrucciones operativas para agentes de código que trabajan sobre el repo | esta bóveda lo estructura en [[Invariantes de arquitectura]] y [[Trampas conocidas]] |

Cuando haya conflicto, **manda el código**. Cada página de arquitectura nombra
los archivos fuente de los que sale, para que puedas verificar en lugar de
creer.

## Cómo mantenerla

Ver [[Convenciones de documentación]]. La regla corta: una página por concepto,
enlaces `[[...]]` en vez de repetir, y ningún dato que el código pueda
contradecir sin que la página diga de dónde salió.
