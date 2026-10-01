import fs from "node:fs";
import path from "node:path";
import { SHOTS } from "./browser.mjs";

const file = path.join(SHOTS, "results.json");

export function loadResults() {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { steps: {}, notes: [] };
}

export function record(id, status, evidence) {
  const r = loadResults();
  r.steps[id] = { status, at: new Date().toISOString(), ...evidence };
  fs.writeFileSync(file, JSON.stringify(r, null, 1));
  console.log(`[${status}] ${id} ${JSON.stringify(evidence).slice(0, 600)}`);
}

export function note(text) {
  const r = loadResults();
  r.notes.push({ at: new Date().toISOString(), text });
  fs.writeFileSync(file, JSON.stringify(r, null, 1));
}
