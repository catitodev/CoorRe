import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS_ROOT } from "./paths.mjs";

export function artifactPath(source, name) {
  return join(ARTIFACTS_ROOT, "contracts", source, `${name}.json`);
}

export async function loadArtifact(source, name) {
  const path = artifactPath(source, name);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  const buildInfo = JSON.parse(await readFile(join(ARTIFACTS_ROOT, "build-info", `${artifact.buildInfoId}.output.json`), "utf8"));
  const identifiers = buildInfo.output.contracts[artifact.inputSourceName][artifact.contractName].evm.methodIdentifiers;
  return {
    path,
    abi: artifact.abi,
    bytecode: artifact.bytecode.replace(/^0x/, ""),
    deployedBytecode: artifact.deployedBytecode.replace(/^0x/, ""),
    identifiers,
    inputSourceName: artifact.inputSourceName,
    contractName: artifact.contractName,
    buildInfoId: artifact.buildInfoId,
  };
}
