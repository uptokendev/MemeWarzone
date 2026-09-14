import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = fs.readFileSync('.github/workflows/agent4-robinhood-oracle-refresh.yml', 'utf8');
const helper = fs.readFileSync('scripts/rh46630-oracle-refresh-transport.ts', 'utf8');

const mustInclude = (text, needle) => assert.ok(text.includes(needle), `missing ${needle}`);

test('workflow is manual-only and protected', () => {
  mustInclude(workflow, 'workflow_dispatch:');
  assert.ok(!/^\s*push:/m.test(workflow));
  assert.ok(!/^\s*pull_request:/m.test(workflow));
  mustInclude(workflow, "github.event.inputs.confirmation == 'REFRESH_CHAIN_46630_ETH_USD_ORACLE'");
  mustInclude(workflow, "github.ref_name == 'build/cross-chain-stabilization-rh-base'");
  mustInclude(workflow, 'environment: testnet-certification');
  mustInclude(workflow, 'ROBINHOOD_TESTNET_RPC_URL: ${{ secrets.ROBINHOOD_TESTNET_RPC_URL }}');
  mustInclude(workflow, 'ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: ${{ secrets.ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY }}');
  assert.ok(!workflow.includes('4663 --network'));
});

test('helper is pinned to RH46630 oracle and updater and rejects unsafe input', () => {
  mustInclude(helper, 'const EXPECTED_CHAIN_ID = 46630;');
  mustInclude(helper, 'const FORBIDDEN_CHAIN_ID = 4663;');
  mustInclude(helper, '0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb');
  mustInclude(helper, '0xE755A2c52654b2133c7A4fdC5349821C6527A766');
  mustInclude(helper, 'WRONG_UPDATER_KEY');
  mustInclude(helper, 'WRONG_ORACLE');
  mustInclude(helper, 'ANSWER_MUST_BE_POSITIVE');
  mustInclude(helper, 'ORACLE_DECIMALS_MISMATCH');
  mustInclude(helper, 'await oracle.updateAnswer(answer)');
  mustInclude(helper, 'age >= 900n');
});

test('helper output contains only public refresh evidence fields', () => {
  mustInclude(helper, 'txHash: receipt.hash');
  mustInclude(helper, 'block: receipt.blockNumber');
  mustInclude(helper, 'roundId: roundId.toString()');
  mustInclude(helper, 'answer: observedAnswer.toString()');
  mustInclude(helper, 'updatedAt: updatedAt.toString()');
  mustInclude(helper, 'age: age.toString()');
  mustInclude(helper, 'chainId,');
  mustInclude(helper, 'oracle: oracleAddress');
  mustInclude(helper, 'updater,');
  assert.ok(!helper.includes('console.log(pk'));
  assert.ok(!helper.includes('console.log(rpc'));
});
