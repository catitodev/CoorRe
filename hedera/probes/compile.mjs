import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import solc from "solc";
import { CACHE_ROOT, HEDERA_ROOT, readLock, sha256Hex } from "../scripts/wata-lock.mjs";

export const BUILD_ROOT = join(HEDERA_ROOT, ".cache", "build");
const PROBE_SOURCES = ["CallerProbe.sol"];

export function compilerInput(lock, sources) {
  return {
    language: "Solidity",
    sources,
    settings: {
      optimizer: lock.compiler.optimizer,
      viaIR: lock.compiler.viaIR,
      evmVersion: lock.compiler.evmVersion,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
}

export function collectContracts(output) {
  const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const contracts = {};
  for (const [source, byName] of Object.entries(output.contracts ?? {})) {
    for (const [name, artifact] of Object.entries(byName)) {
      const bytecode = artifact.evm.bytecode.object;
      if (bytecode.length === 0) continue;
      contracts[name] = {
        source,
        abi: artifact.abi,
        bytecode,
        bytecodeSha256: sha256Hex(Buffer.from(bytecode, "hex")),
        deployedBytecodeSha256: sha256Hex(Buffer.from(artifact.evm.deployedBytecode.object, "hex")),
      };
    }
  }
  return contracts;
}

export function checkReproduced(lock, contracts) {
  for (const file of lock.files.filter((entry) => entry.use === "compile")) {
    const built = contracts[file.contract];
    if (!built) throw new Error(`${file.contract} was not produced by the compiler`);
    if (built.bytecodeSha256 !== file.bytecodeSha256) {
      throw new Error(`${file.contract} bytecode ${built.bytecodeSha256} does not reproduce the pinned ${file.bytecodeSha256}`);
    }
  }
}

async function main() {
  const lock = await readLock();
  if (!solc.version().startsWith(`${lock.compiler.solc}+`)) {
    throw new Error(`solc ${solc.version()} does not match the pinned ${lock.compiler.solc}`);
  }
  const sources = {};
  for (const file of lock.files.filter((entry) => entry.use === "compile")) {
    const bytes = await readFile(join(CACHE_ROOT, lock.commit, file.path));
    if (sha256Hex(bytes) !== file.sha256) throw new Error(`${file.path} in the cache does not match the lock; run wata-fetch`);
    sources[file.path.replace(/^contracts\//, "")] = { content: bytes.toString("utf8") };
  }
  for (const name of PROBE_SOURCES) {
    sources[`probes/${name}`] = { content: await readFile(join(HEDERA_ROOT, "probes", "contracts", name), "utf8") };
  }
  const output = JSON.parse(solc.compile(JSON.stringify(compilerInput(lock, sources))));
  const contracts = collectContracts(output);
  checkReproduced(lock, contracts);
  await mkdir(BUILD_ROOT, { recursive: true });
  const build = { solc: solc.version(), wataCommit: lock.commit, contracts };
  await writeFile(join(BUILD_ROOT, "contracts.json"), `${JSON.stringify(build, null, 2)}\n`);
  for (const [name, artifact] of Object.entries(contracts)) {
    console.log(`${name.padEnd(16)} ${artifact.bytecodeSha256} ${artifact.source}`);
  }
  console.log(`compiled with ${solc.version()} into ${join(BUILD_ROOT, "contracts.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`compile: ${error.message}`);
    process.exit(1);
  });
}
