import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const target = path.resolve(process.argv[2] || "scripts/test-bnb97-native-pending-graduation.ts");
if (!fs.existsSync(target)) throw new Error(`final cert executable missing: ${target}`);

const options = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  types: ["node"],
};

const program = ts.createProgram([target], options);
const source = program.getSourceFile(target);
if (!source) throw new Error(`unable to load final cert executable: ${target}`);

const relevantCodes = new Set([2300, 2307, 2393, 2451, 2792]);
const diagnostics = [
  ...program.getSyntacticDiagnostics(source),
  ...program.getSemanticDiagnostics(source).filter((d) => relevantCodes.has(d.code)),
];
if (diagnostics.length) {
  const host = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
  throw new Error(`final executable type/load gate failed:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, host)}`);
}

const transpiled = ts.transpileModule(fs.readFileSync(target, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
const transpileErrors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
if (transpileErrors.length) {
  throw new Error(`final executable transpile gate failed: ${transpileErrors.map((d) => d.messageText).join("; ")}`);
}

new vm.Script(transpiled.outputText, { filename: `${target}.transpiled.js` });
console.log(`bnb97_final_executable_zero_network_gate=ok target=${path.relative(process.cwd(), target)}`);
