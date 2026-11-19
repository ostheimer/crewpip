import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { APP_LABELS, type Message } from "@crewpip/shared";
import { de } from "./locales/de.ts";
import { en } from "./locales/en.ts";

export type Language = "de" | "en";
const storageKey = "crewpip.language";
const copy = { de, en };
const locale = { de: "de-AT", en: "en" };

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "de" || saved === "en") return saved;
  } catch { /* A blocked store still allows an in-memory choice. */ }
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const language = tag?.split("-")[0].toLowerCase();
    if (language === "de" || language === "en") return language;
  }
  return "en";
}

const LanguageContext = createContext<{ language: Language; chooseLanguage: (language: Language) => void } | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  function chooseLanguage(next: Language) {
    setLanguage(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Keep the choice for this visit. */ }
  }
  return <LanguageContext.Provider value={{ language, chooseLanguage }}>{children}</LanguageContext.Provider>;
}

export function useBoardLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("Missing board language provider");
  return { ...context, ui: copy[context.language], locale: locale[context.language] };
}

export function recipientLabel(message: Message, language: Language) {
  if (language === "de") return message.toLabel;
  const target = message.to;
  switch (target.kind) {
    case "all": return "everyone";
    case "director": return "the Director";
    case "pm": return `PM for ${target.project}`;
    case "project": return `Project ${target.name}`;
    case "app": return `all ${APP_LABELS[target.app]} chats`;
    case "human":
    case "session": return message.toLabel;
  }
}
