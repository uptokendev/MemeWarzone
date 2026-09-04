#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  proveProductionRobinhoodDisabled,
  requireRobinhoodTestnetFreeze,
} from "./robinhoodTestnetFreeze.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function renderMarkdown(report) {
  const rows = [
    ["result", report.result],
    ["accepted5BSha", report.accepted5BSha],
    ["freezeSchemaVersion", report.freezeSchemaVersion],
    ["verifiedAt", report.verifiedAt],
    ["chainId", report.chainId],
    ["currentBlock", report.currentBlock],
    ["factory", report.factory],
    ["factoryGeneration", report.factoryGeneration],
    ["campaignGeneration", report.campaignGeneration],
    ["admin", report.admin],
    ["routeAuthority", report.routeAuthority],
    ["routeAuthorityDiffersFromAdmin", report.routeAuthorityDiffersFromAdmin],
    ["live", report.live],
    ["createPaused", report.createPaused],
    ["campaignsCount", report.campaignsCount],
    ["factoryStartBlock", report.factoryStartBlock],
    ["continuityOk", report.continuity.ok],
    ["no56Alias", report.no56Alias],
    ["productionRobinhoodDisabled", report.productionRobinhoodDisabled],
  ];
  return [
    "# Robinhood testnet 5C acceptance freeze",
    "",
    "Generated from proof JSON. Do not hand-edit.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | \`${String(v)}\` |`),
    "",
  ].join("\n");
}

const freeze = requireRobinhoodTestnetFreeze();
const flags = proveProductionRobinhoodDisabled();
const verifyFile = String(process.env.ROBINHOOD_5C_VERIFY_RESULT_FILE || path.join(root, "reports/robinhood-testnet-acceptance-5c.verify.json")).trim();
if (!fs.existsSync(verifyFile)) {
  throw new Error(`5C on-chain verify result missing: ${verifyFile}. Run verify-robinhood-testnet-acceptance-freeze.ts first.`);
}
const verify = readJson(verifyFile);
if (verify.result !== "PASS") throw new Error("5C on-chain verify did not PASS");
if (Number(verify.chainId) !== 46630) throw new Error("5C report refuses a non-46630 verify result");
if (verify.live !== true || verify.createPaused !== true) throw new Error("5C report requires live=true and createPaused=true");
if (verify.routeAuthorityDiffersFromAdmin !== true) throw new Error("5C report requires routeAuthority != admin");

const continuityFile = String(process.env.ROBINHOOD_5C_CONTINUITY_RESULT_FILE || path.join(root, "reports/robinhood-testnet-acceptance-5c.continuity.json")).trim();
if (!fs.existsSync(continuityFile)) {
  throw new Error(`5C continuity result missing: ${continuityFile}`);
}
const continuity = readJson(continuityFile);
if (continuity.ok !== true || continuity.no56Alias !== true) {
  throw new Error("5C continuity did not prove 46630 rows with zero chain-56 aliases");
}

const report = {
  kind: "robinhood-testnet-acceptance-5c-report",
  result: "PASS",
  accepted5BSha: freeze.accepted5BSha,
  freezeSchemaVersion: Number(freeze.schemaVersion || 1),
  verifiedAt: verify.verifiedAt,
  chainId: verify.chainId,
  currentBlock: verify.currentBlock,
  factory: verify.factory,
  factoryGeneration: verify.factoryGeneration,
  campaignGeneration: verify.campaignGeneration,
  admin: verify.admin,
  routeAuthority: verify.routeAuthority,
  routeAuthorityDiffersFromAdmin: verify.routeAuthorityDiffersFromAdmin,
  live: verify.live,
  createPaused: verify.createPaused,
  campaignsCount: verify.campaignsCount,
  factoryStartBlock: verify.factoryStartBlock,
  continuity: continuity,
  no56Alias: continuity.no56Alias,
  productionRobinhoodDisabled: flags.productionCreationEnabled === false && flags.directRobinhoodDeployEnabled === false,
  productionFlags: flags,
  factoryUntouched: true,
};

fs.mkdirSync(path.join(root, "reports"), { recursive: true });
const jsonOut = path.join(root, "reports/robinhood-testnet-acceptance-5c.json");
const mdOut = path.join(root, "reports/robinhood-testnet-acceptance-5c.md");
fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(mdOut, renderMarkdown(report));
console.log("Robinhood 5C report written", { jsonOut, mdOut, result: report.result });
