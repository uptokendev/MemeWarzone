import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [home, details, commandCenter, coinRow] = await Promise.all([
  read("./components/home/ImportedProjectsOverlay.tsx"),
  read("./pages/ImportedTokenDetailsPage.tsx"),
  read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./components/postgrad/CommandCenterCoinRow.tsx"),
]);

test("homepage imported project card consumes resolved name and $symbol", () => {
  assert.match(home, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(home, /item\.symbol \? `\$\$\{item\.symbol\}` : ""/);
});

test("temporary imported TokenDetails consumes resolved name and $symbol", () => {
  assert.match(details, /data-project-name="true"/);
  assert.match(details, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(details, /data-project-ticker="true">\$\{item\.symbol\}/);
});

test("Command Center consumes imported name and formats resolved ticker as $symbol", () => {
  assert.match(commandCenter, /name: project\.name \|\| project\.symbol \|\| "Imported project"/);
  assert.match(commandCenter, /ticker: project\.symbol \|\| "\?\?\?"/);
  assert.match(coinRow, /isImported[\s\S]*item\.ticker && item\.ticker !== "\?\?\?" \? `\$\$\{item\.ticker\}` : item\.name/);
  assert.match(coinRow, />\{displayedTicker\}<\/div>/);
});

test("generic placeholders are display fallbacks only when resolved identity is absent", () => {
  assert.match(home, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(details, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(coinRow, /item\.ticker !== "\?\?\?"/);
});
