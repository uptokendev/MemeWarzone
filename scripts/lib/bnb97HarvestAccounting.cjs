const CREATOR_FEE_BPS = 8000n;
const FEE_BPS = 10000n;

function acceptedHarvestSplit(collected) {
  if (typeof collected !== "bigint" || collected < 0n) throw new Error("invalid harvested amount");
  const creatorPaid = (collected * CREATOR_FEE_BPS) / FEE_BPS;
  const protocolRouted = collected - creatorPaid;
  return { creatorPaid, protocolRouted };
}

function validateHarvestAssetRecord(record) {
  const {
    token,
    collected,
    creatorPaid,
    protocolRouted,
    creatorBefore,
    creatorAfter,
    protocolBefore,
    protocolAfter,
  } = record;

  for (const [name, value] of Object.entries({
    collected,
    creatorPaid,
    protocolRouted,
    creatorBefore,
    creatorAfter,
    protocolBefore,
    protocolAfter,
  })) {
    if (typeof value !== "bigint" || value < 0n) throw new Error(`${name} must be a non-negative bigint`);
  }

  const expected = acceptedHarvestSplit(collected);
  if (creatorPaid + protocolRouted !== collected) {
    throw new Error(`${token}: FeesHarvested does not conserve collected amount`);
  }
  if (creatorPaid !== expected.creatorPaid) {
    throw new Error(`${token}: creator share does not equal floor(collected * 8000 / 10000)`);
  }
  if (protocolRouted !== expected.protocolRouted) {
    throw new Error(`${token}: protocol share does not receive the exact arithmetic remainder`);
  }

  const creatorDelta = creatorAfter - creatorBefore;
  const protocolDelta = protocolAfter - protocolBefore;
  if (creatorDelta !== creatorPaid) {
    throw new Error(`${token}: creator balance delta does not match FeesHarvested.creatorPaid`);
  }
  if (protocolDelta !== protocolRouted) {
    throw new Error(`${token}: protocol balance delta does not match FeesHarvested.protocolRouted`);
  }
  if (creatorDelta + protocolDelta !== collected) {
    throw new Error(`${token}: recipient balance deltas do not conserve harvested amount`);
  }

  return {
    token,
    collected,
    creatorPaid,
    protocolRouted,
    creatorBefore,
    creatorAfter,
    creatorDelta,
    protocolBefore,
    protocolAfter,
    protocolDelta,
  };
}

module.exports = {
  CREATOR_FEE_BPS,
  FEE_BPS,
  acceptedHarvestSplit,
  validateHarvestAssetRecord,
};
