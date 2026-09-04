import { getChainDefinition, type ChainKey } from "@/lib/chainRegistry";
import {
  assertEnvironmentMatch,
  type RuntimeEnvironment,
} from "@/lib/runtimeEnvironment";

export interface DeploymentContracts {
  factory?: string;
  campaignImplementation?: string;
  creatorRegistry?: string;
  riskRegistry?: string;
  treasuryRouter?: string;
  graduationOracle?: string;
  graduationAdapter?: string;
  liquidityLocker?: string;
  dexRouter?: string;
  dexFactory?: string;
  wrappedNative?: string;
}

export interface DeploymentManifest {
  schemaVersion: 1;
  chainKey: ChainKey;
  chainId: number;
  environment: Exclude<RuntimeEnvironment, "local">;
  generation: number;
  deploymentBlock: number | null;
  supportEnabled: boolean;
  creationEnabled: boolean;
  contracts: DeploymentContracts;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function assertOptionalAddress(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!EVM_ADDRESS.test(value)) {
    throw new Error(`Invalid EVM address in deployment manifest: ${field}`);
  }
}

export function validateDeploymentManifest(
  manifest: DeploymentManifest,
  runtimeEnvironment: Exclude<RuntimeEnvironment, "local">,
): DeploymentManifest {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported deployment manifest schema: ${manifest.schemaVersion}`);
  }

  const chain = getChainDefinition(manifest.chainKey);

  assertEnvironmentMatch(runtimeEnvironment, manifest.environment, `Manifest ${manifest.chainKey}`);
  assertEnvironmentMatch(runtimeEnvironment, chain.runtimeEnvironment, `Chain ${manifest.chainKey}`);

  if (manifest.chainId !== chain.chainId) {
    throw new Error(
      `Manifest chain mismatch for ${manifest.chainKey}: expected ${chain.chainId}, got ${manifest.chainId}`,
    );
  }

  if (!Number.isInteger(manifest.generation) || manifest.generation < 1) {
    throw new Error(`Invalid generation for ${manifest.chainKey}: ${manifest.generation}`);
  }

  if (
    manifest.deploymentBlock !== null &&
    (!Number.isInteger(manifest.deploymentBlock) || manifest.deploymentBlock < 0)
  ) {
    throw new Error(`Invalid deployment block for ${manifest.chainKey}`);
  }

  for (const [field, value] of Object.entries(manifest.contracts)) {
    assertOptionalAddress(value, field);
  }

  if (manifest.creationEnabled && !manifest.supportEnabled) {
    throw new Error(`Creation cannot be enabled while support is disabled for ${manifest.chainKey}`);
  }

  if (manifest.creationEnabled && !chain.supportsCreation) {
    throw new Error(`Chain registry does not permit creation for ${manifest.chainKey}`);
  }

  return manifest;
}

export function assertManifestReadyForCreation(manifest: DeploymentManifest): void {
  if (!manifest.supportEnabled || !manifest.creationEnabled) {
    throw new Error(`Deployment manifest ${manifest.chainKey} is not enabled for creation`);
  }

  const required: (keyof DeploymentContracts)[] = [
    "factory",
    "campaignImplementation",
    "creatorRegistry",
    "riskRegistry",
    "treasuryRouter",
    "graduationOracle",
    "graduationAdapter",
    "liquidityLocker",
  ];

  for (const field of required) {
    if (!manifest.contracts[field]) {
      throw new Error(`Deployment manifest ${manifest.chainKey} is missing ${field}`);
    }
  }
}
