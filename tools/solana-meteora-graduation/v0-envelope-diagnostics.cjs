'use strict';

const fs = require('node:fs');
const web3 = require('@solana/web3.js');

const REPORT = process.env.SOLANA_V0_DIAGNOSTIC_REPORT || '/tmp/mwz-agent2-v0-envelope.json';
const original = web3.MessageV0.prototype.serialize;

function asBase58(value) {
  try { return value?.toBase58?.() || String(value); } catch { return String(value); }
}

web3.MessageV0.prototype.serialize = function patchedSerialize() {
  const report = {
    header: this.header,
    staticAccountKeyCount: this.staticAccountKeys?.length || 0,
    staticAccountKeys: (this.staticAccountKeys || []).map(asBase58),
    lookupCount: this.addressTableLookups?.length || 0,
    addressTableLookups: (this.addressTableLookups || []).map((lookup) => ({
      accountKey: asBase58(lookup.accountKey),
      writableIndexes: Array.from(lookup.writableIndexes || []),
      readonlyIndexes: Array.from(lookup.readonlyIndexes || []),
    })),
    compiledInstructionCount: this.compiledInstructions?.length || 0,
    compiledInstructions: (this.compiledInstructions || []).map((ix, index) => ({
      index,
      programIdIndex: ix.programIdIndex,
      accountKeyIndexCount: ix.accountKeyIndexes?.length || 0,
      accountKeyIndexes: Array.from(ix.accountKeyIndexes || []),
      dataBytes: ix.data?.length || 0,
    })),
  };
  report.loadedLookupKeyCount = report.addressTableLookups.reduce(
    (sum, lookup) => sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
    0,
  );
  report.totalResolvedAccountKeyCount = report.staticAccountKeyCount + report.loadedLookupKeyCount;
  report.requiredSignatureCount = Number(report.header?.numRequiredSignatures || 0);
  report.signatureSectionBytes = 1 + (64 * report.requiredSignatureCount);
  report.staticKeyBytes = 32 * report.staticAccountKeyCount;
  report.instructionDataBytes = report.compiledInstructions.reduce((sum, ix) => sum + ix.dataBytes, 0);
  report.instructionAccountIndexBytes = report.compiledInstructions.reduce((sum, ix) => sum + ix.accountKeyIndexCount, 0);
  try {
    const out = original.call(this);
    report.messageSerializedBytes = out.length;
    report.transactionSerializedBytes = report.signatureSectionBytes + out.length;
    report.serializeResult = 'PASS';
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.error('[agent2-v0-diagnostic]', JSON.stringify(report));
    return out;
  } catch (error) {
    report.serializeResult = 'FAIL';
    report.serializeError = String(error?.stack || error);
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.error('[agent2-v0-diagnostic]', JSON.stringify(report));
    throw error;
  }
};
