import { readToken } from "./crewpip-hook.mjs";

const token = readToken();
if (!token) {
  process.stderr.write("CrewPip-Zugang nicht verfügbar. Prüfe die Tokendatei.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ "x-crewpip-token": token }) + "\n");
}
