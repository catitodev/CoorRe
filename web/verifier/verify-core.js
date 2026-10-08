export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function fetchAccounts(rpcUrl, addresses, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!response.ok) throw new Error(`RPC answered HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const values = body.result?.value;
  if (!Array.isArray(values) || values.length !== addresses.length) {
    throw new Error("RPC returned an unexpected answer");
  }
  return {
    slot: body.result.context?.slot,
    accounts: values.map((value, i) =>
      value ? { address: addresses[i], owner: value.owner, data: base64ToBytes(value.data[0]) } : null
    ),
  };
}

export async function verifyBundle({
  wasm,
  bundleText,
  files,
  rpcUrl,
  programId,
  networkId,
  tamper = false,
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
    const { slot, accounts } = await fetchAccounts(rpcUrl, addresses, fetchImpl);
    for (const account of accounts) {
      if (account) verifier.addAccount(account.address, account.owner, account.data);
    }
    const report = JSON.parse(verifier.verify(programId, networkId));
    return {
      report,
      slot,
      declared,
      missing: declared.filter((name) => !provided.has(name)),
      tamperedName,
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
