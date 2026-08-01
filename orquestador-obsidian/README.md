# orquestador-obsidian

Bóveda de documentación del **Orquestador Agéntico**.

Abrila con Obsidian (`Archivo → Abrir bóveda → Abrir carpeta como bóveda`)
apuntando a esta carpeta, o leela como markdown plano en cualquier editor — en
ese caso perdés el grafo y los enlaces `[[...]]` navegables.

**Empezá por [[Inicio]].**

```
├── Inicio.md              el MOC principal
├── 00-Meta/               cómo se escribe y se lee esta documentación
├── 01-Producto/           qué es, para quién, en qué estado
├── 02-Arquitectura/       cómo está construido y por qué (+ ADR/)
├── 03-Capacidades/        qué sabe hacer el sistema
├── 04-Casos-de-uso/       recorridos completos de punta a punta
├── 05-Operación/          instalar, configurar, correr, diagnosticar
├── 06-Referencia/         tablas para consultar, no para leer
└── 07-Contribuir/         cómo extenderlo sin romper nada
```

Esta bóveda no reemplaza al `README.md` de la raíz (pitch del producto) ni a
`CLAUDE.md` (instrucciones para agentes de código): los expande y los estructura.
**Cuando haya conflicto, manda el código** — cada página de arquitectura nombra
los archivos fuente de los que sale.
