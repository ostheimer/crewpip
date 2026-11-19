import type { Language } from "./language.tsx";

// The daemon is shared with existing clients and returns German diagnostics.
// Only translate known messages at the display boundary. Preserve names and tool output.
const english: Record<string, string> = {
  "Verbindung fehlgeschlagen.": "Connection failed.",
  "Verbindung fehlgeschlagen. Bitte erneut versuchen.": "Connection failed. Please try again.",
  "Verbindung fehlgeschlagen. Der Start ist nicht bestätigt; vor erneutem Start die Läufe prüfen.": "Connection failed. Check the run list before starting another run.",
  "Agentenstatus konnte nicht geladen werden. Aufgaben bleiben bedienbar.": "Could not load agent status. You can still use tasks.",
  "Senden fehlgeschlagen": "Could not send the message.",
  "Senden fehlgeschlagen. Dein Text bleibt erhalten.": "Could not send the message. Your draft was kept.",
  "Änderung fehlgeschlagen": "Could not save the change.",
  "Austragen fehlgeschlagen": "Could not unregister the chat.",
  "Start fehlgeschlagen": "Could not start the run.",
  "Erst einen Titel eingeben": "Enter a title first.",
  "Bitte zuerst ein Projekt auswählen.": "Select a project first.",
  "Leerer Name": "Enter a name.",
  "Leerer Titel": "Enter a title.",
  "Leere Nachricht": "Enter a message.",
  "Leerer Auftrag": "Enter instructions for the agent.",
  "Unbekannte Session": "Unknown chat.",
  "Unbekanntes Projekt": "Unknown project.",
  "Weder Name noch Rolle angegeben": "Provide a name or a role.",
  "Weder Task noch Projekt angegeben": "Provide a task or project.",
  "Kein Feld bootstrap angegeben": "The bootstrap field is missing.",
  "Unerwarteter Host": "Unexpected host.",
  "Unerlaubte Herkunft": "This origin is not allowed.",
  "Token fehlt oder stimmt nicht. Es steht in ~/.crewpip/token.": "The token is missing or incorrect. Check ~/.crewpip/token.",
  "Schreibende Läufe brauchen einen Worktree. Lege für den Task einen an, oder erlaube den Haupt-Checkout ausdrücklich.": "Write-enabled runs need a worktree. Create one for the task or explicitly allow the main checkout.",
  "In einem Terminal `codex login` ausführen; die ChatGPT-App teilt ihre Anmeldung mit dem CLI.": "Run `codex login` in a terminal. The ChatGPT app shares its sign-in with the CLI.",
  "Mit dem von CrewPip gefundenen Claude-Programm `auth status` prüfen und bei Bedarf `auth login` ausführen. Die Anmeldung der Desktop-App allein belegt keine CLI-Anmeldung; vor einem Lauf auch die Abrechnungsart prüfen.": "Use the Claude executable detected by CrewPip to run `auth status`, then `auth login` if needed. Check CLI sign-in and billing before starting a run.",
};

const patterns: [RegExp, string][] = [
  [/^Daten konnten nicht geladen werden \((\d+)\)\.$/, "Could not load board data ($1)."],
  [/^Fehlgeschlagen \((\d+)\)$/, "Request failed ($1)"],
  [/^Ungültiger Name: (.*)$/s, "Invalid name: $1"],
  [/^Leeres Ziel: (.*)$/s, "Empty recipient: $1"],
  [/^Unbekannte Session: (.*)$/s, "Unknown chat: $1"],
  [/^Unbekanntes Projekt: (.*)$/s, "Unknown project: $1"],
  [/^Unbekannter Task: (.*)$/s, "Unknown task: $1"],
  [/^Unbekannte App: (.*)$/s, "Unknown app: $1"],
  [/^Unbekannter Modus: (.*)$/s, "Unknown mode: $1"],
  [/^Unbekannter Status: (.*)$/s, "Unknown status: $1"],
  [/^Unbekannte Rolle: (.*)$/s, "Unknown role: $1"],
  [/^Unbekannter Lauf: (.*)$/s, "Unknown run: $1"],
  [/^Statuswechsel (\w+) → (\w+) ist nicht vorgesehen$/, "Cannot change the status from $1 to $2."],
  [/^Task #(\d+) hat schon einen Worktree: (.*)$/s, "Task #$1 already has a worktree: $2"],
  [/^Verzeichnis fehlt: (.*)$/s, "Directory not found: $1"],
  [/^(.*) ist kein git-Repository$/s, "$1 is not a Git repository."],
  [/^(.*) liegt außerhalb von (.*)$/s, "$1 is outside $2"],
  [/^Es laufen bereits (\d+) Agents\. Erst einen beenden\.$/, "$1 agents are already running. Stop one first."],
  [/^(\w+) ist auf diesem Rechner nicht gefunden worden\.$/, "$1 was not found on this computer."],
];

export function displayError(message: string, language: Language): string {
  if (language === "de") return message;
  const reload = " Bitte die Seite neu laden.";
  if (message.endsWith(reload)) return displayError(message.slice(0, -reload.length), language) + " Please reload the page.";
  const signIn = message.match(/^(\w+) ist nicht angemeldet\. (.+)$/s);
  if (signIn) return signIn[1] + " is not signed in. " + displayError(signIn[2], language);
  const blocked = message.match(/^Worktree nicht entfernt: (.+)\. Mit force=true trotzdem entfernen\.$/s);
  if (blocked) {
    const details = blocked[1].replace(/(\d+) nicht committete Änderung\(en\)/, "$1 uncommitted change(s)")
      .replace(/(\d+) Commit\(s\) nicht in /, "$1 commit(s) outside ");
    return "Worktree removal blocked: " + details;
  }
  if (Object.hasOwn(english, message)) return english[message];
  for (const [pattern, translated] of patterns) {
    if (pattern.test(message)) return message.replace(pattern, translated);
  }
  return message;
}
