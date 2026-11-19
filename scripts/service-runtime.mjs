import path from "node:path";
import { execFileSync } from "node:child_process";

const daemonScript = "apps/daemon/dist/index.js";
const standardBins = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export const daemonEntry = (repo) => path.join(repo, daemonScript);

// Nur Metadaten des aufrufenden Node lesen. Keine Werte, Module oder Optionen
// aus der Plist ausführen, um herauszufinden, welches Argument das Skript ist.
function optionMetadata() {
  const describe = (arg) =>
    execFileSync(process.execPath, [arg], {
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  const node = new Map();
  for (const line of describe("--help").split("\n")) {
    if (!line.startsWith("  -")) continue;
    const spellings = line
      .slice(2)
      .split(/\s{2,}/, 1)[0]
      .split(", ");
    const takesValue = spellings.some((spelling) => spelling.includes("=") && !spelling.includes("[="));
    for (const spelling of spellings) {
      const name = spelling.match(/^[-\w]+/)[0];
      node.set(name, takesValue);
    }
  }
  const v8 = new Map();
  for (const [, name, type] of describe("--v8-options").matchAll(/^  (--[\w-]+) \(.*\)\n +type: ([\w_]+)/gm)) {
    v8.set(name, type);
  }
  return { node, v8 };
}

function scriptIndex(args) {
  let metadata;
  for (let i = 1; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--") return i + 1;
    if (!argument.startsWith("-")) return i;
    metadata ??= optionMetadata();
    const [name] = argument.split("=", 1);
    const attached = argument.includes("=");
    // NODE_OPTIONS erlaubt Laufzeitoptionen, aber keine andere Betriebsart (Eval,
    // Syntaxcheck, Testlauf usw.). Die Laufzeit benennt auch ihre booleschen Gegenstücke.
    const allowed = process.allowedNodeEnvironmentFlags;
    if (allowed.has(name)) {
      const counterpart = name.startsWith("--no-") ? "--" + name.slice(5) : "--no-" + name.slice(2);
      if (attached || allowed.has(counterpart)) continue;
      if (metadata.node.get(name) === true) {
        if (!args[i + 1] || args[i + 1].startsWith("-")) return -1;
        i++;
        continue;
      }
      if (metadata.node.get(name) === false) continue;
    }
    // V8 bietet zusätzliche Laufzeitoptionen. Node übergibt V8-Werte direkt
    // als --name=wert. Einen gleichnamigen Node-Betriebsmodus (z. B. --help) ausschließen.
    if (metadata.node.has(name)) return -1;
    const v8name = name.replaceAll("_", "-");
    const type = metadata.v8.get(v8name) ?? metadata.v8.get(v8name.replace(/^--no-?/, "--"));
    if (!type || (type !== "bool" && !attached)) return -1;
  }
  return -1;
}

// Alle drei Startwege verwenden den aufrufenden Checkout und Interpreter.
// Einen individuellen PATH übernehmen wir einschließlich seiner Reihenfolge.
export function serviceRuntime(repo, configuration, { allowNodeOptions = true } = {}) {
  const nextBin = path.dirname(process.execPath);
  let searchPath;
  const currentEntry = daemonEntry(repo);
  let args = [process.execPath, currentEntry];
  if (configuration) {
    const previous = configuration.ProgramArguments;
    if (
      configuration.Program ||
      !Array.isArray(previous) ||
      previous.length < 2 ||
      !previous.every((arg) => typeof arg === "string") ||
      !path.isAbsolute(previous[0]) ||
      (previous[0] !== process.execPath && !/^node(?:js|[-@]?\d+(?:\.\d+)*)?$/.test(path.basename(previous[0])))
    ) {
      throw new Error("Dienst verwendet eine angepasste Startkonfiguration; vor dem Start prüfen");
    }
    const index = allowNodeOptions ? scriptIndex(previous) : 1;
    const entry = previous[index];
    if (!entry || !path.isAbsolute(entry) || !entry.endsWith("/" + daemonScript))
      throw new Error("CrewPip-Daemon ist nicht eindeutig als Startskript erkennbar");
    args = [process.execPath, ...previous.slice(1, index), currentEntry, ...previous.slice(index + 1)];
    searchPath = configuration.EnvironmentVariables?.PATH;
    const previousBin = path.dirname(previous[0]);
    const directories = searchPath?.split(path.delimiter);
    if (previousBin !== nextBin && directories?.[0] === previousBin) {
      const oldRank = standardBins.indexOf(previousBin);
      const remaining = directories
        .slice(1)
        .filter((dir) => dir !== nextBin && (oldRank < 0 || dir !== previousBin));
      if (oldRank >= 0) {
        // Die Erstinstallation hat den Standardpfad mit dem damals vorangestellten Node-Bin zusammengefasst.
        const laterBins = standardBins.slice(oldRank + 1);
        let slot = remaining.findIndex((dir) => laterBins.includes(dir));
        if (slot < 0) slot = remaining.findLastIndex((dir) => standardBins.includes(dir)) + 1;
        remaining.splice(slot, 0, previousBin);
      }
      searchPath = [nextBin, ...remaining].join(path.delimiter);
    }
  } else {
    searchPath = [...new Set([nextBin, ...standardBins])].join(path.delimiter);
  }
  return { args, workingDirectory: repo, searchPath };
}
