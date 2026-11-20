/** Erfundene Beispieldaten (keine echten Repos) für Komponententest, Mock-Daemon und Screenshots. */
const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const MIN = 60000;

const repos = ["admin-ui", "analytics", "auth-service", "billing", "blog", "data-pipeline", "docs-site", "example.org", "infra", "landing", "mobile-app", "search", "shop-api", "web-app"];
const id = name => `p-${name}`;

let n = 0;
function session(repo, app, name, connection, role = null, extra = {}) {
  n += 1;
  return {
    id: `s${String(n).padStart(3, "0")}-${app}`, app, projectId: id(repo), project: repo, worktree: extra.worktree ?? null,
    cwd: `/Users/example/${repo}`, name, label: `${app} · ${repo} / ${name}`, status: connection === "connected" ? "idle" : "idle",
    connection, startedAt: iso(300 * MIN), lastSeenAt: iso((extra.ago ?? 5) * MIN), endedAt: null, pending: 0, task: null, role, spawnedByRun: null,
  };
}

export const sessions = [
  session("example.org", "claude", "Director", "connected", "director"),
  session("example.org", "claude", "PM example.org", "connected", "pm"),
  session("example.org", "claude", "#12 Checkout umbauen", "connected", null, { worktree: "checkout-12" }),
  session("example.org", "codex", "#13 Rechnungen prüfen", "connected"),
  session("example.org", "codex", "#14 Seed-Daten", "stale", null, { ago: 2000 }),
  session("shop-api", "claude", "PM shop-api", "no-hook", "pm"),
  session("shop-api", "codex", "#7 Schnittstelle", "connected"),
  session("shop-api", "cursor", "api-client", "connected"),
  session("web-app", "claude", "PM web-app", "connected", "pm"),
  session("web-app", "claude", "#31 Layout", "connected"),
  session("web-app", "antigravity", "Antigravity 1", "connected"),
  session("docs-site", "codex", "PM docs-site", "connected", "pm"),
  session("billing", "claude", "PM billing", "connected", "pm"),
  session("billing", "codex", "#3 Mahnungen", "no-hook"),
  session("mobile-app", "cursor", "ios-build", "connected"),
  session("infra", "claude", "PM infra", "connected", "pm"),
  session("data-pipeline", "codex", "#9 Import", "connected"),
  session("auth-service", "claude", "PM auth-service", "connected", "pm"),
  session("landing", "claude", "#2 Texte", "stale", null, { ago: 3000 }),
  session("blog", "codex", "#5 RSS", "connected"),
  session("admin-ui", "claude", "PM admin-ui", "connected", "pm"),
  session("analytics", "codex", "#8 Berichte", "connected"),
  session("search", "claude", "PM search", "connected", "pm"),
];

export const projects = [...repos, "archiv-demo"].map(name => ({ id: id(name), name, root: `/Users/example/${name}`, createdAt: iso(9000 * MIN), archivedAt: null, sessions: sessions.filter(s => s.project === name).length, openTasks: 0 }));

const ref = s => ({ id: s.id, app: s.app, projectId: s.projectId, project: s.project, name: s.name, label: s.label });
const by = name => sessions.find(s => s.name === name);
export const flows = [
  { from: { kind: "human", name: "Alex" }, to: ref(by("Director")), count: 2, lastAt: iso(40 * MIN) },
  { from: { kind: "session", ...ref(by("Director")) }, to: ref(by("PM example.org")), count: 3, lastAt: iso(30 * MIN) },
  { from: { kind: "session", ...ref(by("PM example.org")) }, to: ref(by("#12 Checkout umbauen")), count: 5, lastAt: iso(12 * MIN) },
  { from: { kind: "session", ...ref(by("#12 Checkout umbauen")) }, to: ref(by("PM example.org")), count: 2, lastAt: iso(8 * MIN) },
  { from: { kind: "session", ...ref(by("PM example.org")) }, to: ref(by("#13 Rechnungen prüfen")), count: 1, lastAt: iso(90 * MIN) },
];
