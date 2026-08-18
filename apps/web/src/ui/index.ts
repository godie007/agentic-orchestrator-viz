/**
 * La librería de componentes de la aplicación.
 *
 * Las cinco primitivas históricas siguen viviendo en `lib/ui.tsx` y se
 * reexportan desde acá; lo nuevo (modal, toasts, badges, tabs, tema) vive en
 * esta carpeta. Importá siempre desde `../ui/index.js`: cuando la migración
 * termine, `lib/ui.tsx` desaparece sin tocar a nadie.
 */
export { Panel, Button, Status, Empty, Field, inputClass, money, tokens, peso, relativeTime } from "../lib/ui.js";
export { Modal, ConfirmDialog } from "./Modal.js";
export { ToastProvider, useToast, type ClaseDeToast } from "./Toast.js";
export { Badge, Skeleton, IconButton, Tabs } from "./piezas.js";
export { BotonDeTema, type Tema } from "./tema.js";
export { PulsoDeCorrida } from "./PulsoDeCorrida.js";
export {
  ModeloBadge,
  familiaDeModelo,
  nombreCortoDeModelo,
  type FamiliaModelo,
} from "./modelo.js";
