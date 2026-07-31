/** Refilma un guion ya escrito, por su clave, sin levantar una corrida. */
import { writeFile } from "node:fs/promises";
import { renderVideo } from "./packages/tools/src/skills/video.js";

const [runId, key, version, destino] = process.argv.slice(2);
const bundle = (await (await fetch(`http://localhost:3001/api/runs/${runId}`)).json()) as {
  artifacts: Array<{ key: string; version: number; title: string; content: string }>;
};
const artifact = bundle.artifacts.find(
  (a) => a.key === key && a.version === Number(version),
)!;

const t0 = Date.now();
const resultado = await renderVideo(artifact.content, {
  title: artifact.title,
  company: "Codytion S.A.",
  author: "Nadia Bercovich",
  authorTitle: "Realizadora audiovisual",
});
await writeFile(destino!, resultado.bytes);
console.log(
  `ok motor=${resultado.motor} escenas=${resultado.escenas} ` +
    `segundos=${resultado.segundos.toFixed(1)} personajes=${resultado.personajes.join("/")} ` +
    `bytes=${resultado.bytes.length} en ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
