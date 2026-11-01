export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
export const SNAPSHOT_FORMAT = "coorre-devnet-snapshot/1";
export const PUBLISHED_SNAPSHOT = "samples/devnet-snapshot.json";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function fetchOk(url, init, fetchImpl = fetch) {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response;
}

export function decodeAccount(address, value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.owner !== "string") throw new Error(`${address}: account has no owner`);
  const [text, encoding] = Array.isArray(value.data) ? value.data : [];
  if (encoding !== "base64" || typeof text !== "string" || !BASE64.test(text)) throw new Error(`${address}: account is not base64-encoded`);
  return { address, owner: value.owner, lamports: value.lamports, executable: value.executable === true, data: base64ToBytes(text) };
}

export async function fetchAccounts(rpcUrl, addresses, fetchImpl = fetch) {
  const response = await fetchOk(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [addresses, { encoding: "base64", commitment: "confirmed" }],
      }),
    },
    fetchImpl
  );
  const body = await response.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const values = body.result?.value;
  if (!Array.isArray(values) || values.length !== addresses.length) {
    throw new Error("RPC returned an unexpected answer");
  }
  return { slot: body.result.context?.slot, accounts: values.map((value, i) => decodeAccount(addresses[i], value)) };
}

export function isAccountSnapshot(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    value.format === SNAPSHOT_FORMAT &&
    typeof value.network_id === "string" &&
    typeof value.program_id === "string" &&
    Array.isArray(value.addresses) &&
    Array.isArray(value.response?.result?.value)
  );
}

export function looksLikeSnapshot(value) {
  return Boolean(value) && typeof value === "object" && (value.format === SNAPSHOT_FORMAT || (Array.isArray(value.addresses) && "response" in value));
}

export function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function readSnapshotFile(name, bytes, publishedBytes) {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!isAccountSnapshot(value)) throw new Error(`${name} is not a ${SNAPSHOT_FORMAT} snapshot with network_id and program_id`);
  return { value, recorded: sameBytes(bytes, publishedBytes) };
}

export function accountsFromSnapshot(snapshot, addresses, { programId, networkId }) {
  if (!isAccountSnapshot(snapshot)) throw new Error(`not a ${SNAPSHOT_FORMAT} snapshot with network_id and program_id`);
  if (snapshot.network_id !== networkId) throw new Error(`the snapshot was taken on ${snapshot.network_id}, not on the expected network ${networkId}`);
  if (snapshot.program_id !== programId) throw new Error(`the snapshot names program ${snapshot.program_id}, not the expected program ${programId}`);
  const values = snapshot.response.result.value;
  if (values.length !== snapshot.addresses.length) throw new Error("the snapshot lists more addresses than accounts");
  const recorded = new Map();
  snapshot.addresses.forEach((address, i) => {
    const account = decodeAccount(address, values[i]);
    if (account) recorded.set(address, account);
  });
  return { slot: snapshot.response.result.context?.slot, accounts: addresses.map((address) => recorded.get(address) ?? null) };
}

export function verdictTone(report, source) {
  if (!report.checks.every((c) => c.status === "PASS")) return "fail";
  return source === "provided-snapshot" ? "caveat" : "pass";
}

export async function verifyBundle({
  wasm,
  bundleText,
  files,
  rpcUrl,
  programId,
  networkId,
  tamper = false,
  snapshot = null,
  snapshotRecorded = false,
  fetchImpl = fetch,
}) {
  const verifier = new wasm.BundleVerifier(bundleText);
  try {
    const declared = JSON.parse(verifier.declaredArtifacts());
    const provided = new Map(files.map((f) => [f.name, f.bytes]));
    let tamperedName = null;
    for (const name of declared) {
      const bytes = provided.get(name);
      if (!bytes) continue;
      let used = bytes;
      if (tamper && tamperedName === null && bytes.length > 0) {
        used = new Uint8Array(bytes);
        used[0] ^= 0x01;
        tamperedName = name;
      }
      verifier.addArtifact(name, used);
    }
    const addresses = JSON.parse(verifier.requiredAccounts());
    const { slot, accounts } = snapshot ? accountsFromSnapshot(snapshot, addresses, { programId, networkId }) : await fetchAccounts(rpcUrl, addresses, fetchImpl);
    for (const account of accounts) {
      if (account) verifier.addAccount(account.address, account.owner, account.data);
    }
    const report = JSON.parse(verifier.verify(programId, networkId));
    const source = snapshot ? (snapshotRecorded ? "recorded-snapshot" : "provided-snapshot") : "rpc";
    return {
      report,
      slot,
      declared,
      missing: declared.filter((name) => !provided.has(name)),
      tamperedName,
      source,
      tone: verdictTone(report, source),
      bundleProgramId: verifier.bundleProgramId(),
      bundleNetworkId: verifier.bundleNetworkId(),
    };
  } finally {
    verifier.free();
  }
}

export function explorerUrl(kind, value, networkId) {
  if (networkId !== "solana:devnet" || typeof value !== "string" || !BASE58.test(value)) return null;
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}
