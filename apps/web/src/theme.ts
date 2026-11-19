import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";
const storageKey = "crewpip.theme";

function saved(): ThemeChoice {
  try {
    const v = localStorage.getItem(storageKey);
    if (v === "system" || v === "dark" || v === "light") return v;
  } catch { /* Ein blockierter Speicher erlaubt weiter eine Wahl im Speicher. */ }
  return "dark";
}

function apply(choice: ThemeChoice) { if (typeof document !== "undefined") document.documentElement.dataset.theme = choice; }

// Vor dem ersten Rendern setzen, damit die Seite nicht kurz in der falschen Farbe aufblitzt.
apply(saved());

export function useTheme() {
  const [theme, setTheme] = useState<ThemeChoice>(saved);
  useEffect(() => { apply(theme); }, [theme]);
  function chooseTheme(next: ThemeChoice) {
    setTheme(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Wahl gilt für diesen Besuch. */ }
  }
  return { theme, chooseTheme };
}
