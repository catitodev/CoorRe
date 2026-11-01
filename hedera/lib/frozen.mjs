import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "./canonical.mjs";
import { HEDERA_ROOT } from "./paths.mjs";

export const FROZEN_SOURCES = {
  "contracts/CoorReMandateGate.sol": "32b2f9b6629c69b23aff376420f4459078d555320b3a60571da4bc1e7669e55b",
  "contracts/IPeriodEscrow.sol": "4534963902b0db12dfc4514c5ab0f670791b9914ca976fa7c7edde23e23002e3",
};

export async function frozenSourceDigests(root = HEDERA_ROOT) {
  const digests = {};
  for (const path of Object.keys(FROZEN_SOURCES)) digests[path] = sha256Hex(await readFile(join(root, path)));
  return digests;
}

export async function assertFrozenSources(root = HEDERA_ROOT) {
  const digests = await frozenSourceDigests(root);
  const changed = Object.entries(FROZEN_SOURCES).filter(([path, expected]) => digests[path] !== expected);
  if (changed.length > 0) {
    throw new Error(`deployed sources changed: ${changed.map(([path]) => `${path} has sha256 ${digests[path]}, expected ${FROZEN_SOURCES[path]}`).join("; ")}`);
  }
  return digests;
}

export function comparableRuntime(deployedBytecodeHex, immutableReferences) {
  const clean = String(deployedBytecodeHex).replace(/^0x/, "");
  if (!/^([0-9a-f]{2})+$/.test(clean)) throw new Error("runtime bytecode must be lowercase hex with whole bytes");
  const bytes = Buffer.from(clean, "hex");
  if (bytes.length < 2) throw new Error("runtime bytecode is too short");
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  if (metadataLength + 2 > bytes.length || (bytes[bytes.length - metadataLength - 2] & 0xe0) !== 0xa0) throw new Error("runtime bytecode has no CBOR metadata trailer");
  const code = Buffer.from(bytes.subarray(0, bytes.length - metadataLength - 2));
  for (const references of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of references) {
      if (start + length > code.length) throw new Error("an immutable reference is outside the runtime code");
      code.fill(0, start, start + length);
    }
  }
  return code;
}
