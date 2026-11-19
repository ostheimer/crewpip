// Übernimmt ausschließlich die gespeicherte Absenderwahl auf diesem Browser.
try {
  const previous = "mngboard.humanName";
  const current = "crewpip.humanName";
  const name = localStorage.getItem(previous);
  if (name !== null) {
    if (localStorage.getItem(current) === null) localStorage.setItem(current, name);
    localStorage.removeItem(previous);
  }
} catch {
  /* Auch bei gesperrtem Speicher kann das Board geöffnet werden. */
}
