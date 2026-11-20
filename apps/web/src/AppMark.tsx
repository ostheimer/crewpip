import type { ReactElement } from "react";
import { APP_LABELS, type AppKind } from "@crewpip/shared";

/**
 * Eigene, neutrale Anbieter-Symbole (keine Marken von Anthropic, OpenAI, Anysphere oder Google, siehe #15 und #20):
 * jede App hat eine eigene Form, dazu immer der Name. So ist der Anbieter auch ohne Farbe
 * erkennbar. Die Formen verwendet auch die Verbindungsgrafik.
 */
export const APP_SHAPES: Record<AppKind, (size: number) => ReactElement> = {
  claude: s => <circle cx={s / 2} cy={s / 2} r={s / 2 - 1} />,
  codex: s => <rect x={1} y={1} width={s - 2} height={s - 2} />,
  cursor: s => <polygon points={`${s / 2},1 ${s - 1},${s - 1} 1,${s - 1}`} />,
  // Sechseck: neutral, von Kreis, Quadrat, Dreieck und Raute klar zu unterscheiden.
  antigravity: s => <polygon points={`${s * 0.25},1 ${s * 0.75},1 ${s - 1},${s / 2} ${s * 0.75},${s - 1} ${s * 0.25},${s - 1} 1,${s / 2}`} />,
  other: s => <polygon points={`${s / 2},0.5 ${s - 0.5},${s / 2} ${s / 2},${s - 0.5} 0.5,${s / 2}`} />,
};

export function AppMark({ app }: { app: AppKind }) {
  return <span className={`app-mark badge app-${app}`} data-app={app}>
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">{APP_SHAPES[app](12)}</svg>{APP_LABELS[app]}
  </span>;
}
