use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, anyhow, bail};
use coorre_verify::AccountSnapshot;
use serde_json::Value;

pub struct RecordedAccounts {
    pub slot: Option<u64>,
    pub accounts: BTreeMap<String, AccountSnapshot>,
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn decode_base64(text: &str) -> anyhow::Result<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        bail!("base64 length is not a multiple of 4");
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let chunks = bytes.len() / 4;
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let padding = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && i + 1 != chunks) {
            bail!("misplaced base64 padding");
        }
        let mut word = 0u32;
        for &b in &chunk[..4 - padding] {
            let value = sextet(b).ok_or_else(|| anyhow!("invalid base64 character"))?;
            word = (word << 6) | u32::from(value);
        }
        word <<= 6 * padding as u32;
        let decoded = word.to_be_bytes();
        let unused_bits = match padding {
            1 => word & 0xff,
            2 => word & 0xffff,
            _ => 0,
        };
        if unused_bits != 0 {
            bail!("non-canonical base64 padding bits");
        }
        out.extend_from_slice(&decoded[1..4 - padding]);
    }
    Ok(out)
}

pub fn accounts_from_rpc(recorded: &Value) -> anyhow::Result<RecordedAccounts> {
    let addresses: Vec<&str> = recorded
        .get("addresses")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("snapshot has no addresses list"))?
        .iter()
        .map(|a| a.as_str().ok_or_else(|| anyhow!("address is not a string")))
        .collect::<anyhow::Result<_>>()?;
    let result = recorded
        .pointer("/response/result")
        .ok_or_else(|| anyhow!("snapshot has no getMultipleAccounts result"))?;
    let values = result
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("getMultipleAccounts result has no value list"))?;
    if values.len() != addresses.len() {
        bail!(
            "snapshot lists {} addresses but holds {} accounts",
            addresses.len(),
            values.len()
        );
    }
    let mut accounts = BTreeMap::new();
    for (address, value) in addresses.into_iter().zip(values) {
        if value.is_null() {
            continue;
        }
        let owner = value
            .get("owner")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("{address}: account has no owner"))?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("{address}: account has no data"))?;
        let (Some(encoded), Some("base64")) = (
            data.first().and_then(Value::as_str),
            data.get(1).and_then(Value::as_str),
        ) else {
            bail!("{address}: account data is not base64-encoded");
        };
        let snapshot = AccountSnapshot {
            owner: owner.to_owned(),
            data: decode_base64(encoded).with_context(|| address.to_owned())?,
        };
        if accounts.insert(address.to_owned(), snapshot).is_some() {
            bail!("{address} appears twice in the snapshot");
        }
    }
    Ok(RecordedAccounts {
        slot: result.pointer("/context/slot").and_then(Value::as_u64),
        accounts,
    })
}

pub fn load_recorded_accounts(path: &Path) -> anyhow::Result<RecordedAccounts> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))?;
    accounts_from_rpc(&value).with_context(|| format!("{}", path.display()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests")]

    use super::*;
    use serde_json::json;

    #[test]
    fn decode_base64_matches_the_rfc_4648_vectors() {
        for (encoded, plain) in [
            ("", ""),
            ("Zg==", "f"),
            ("Zm8=", "fo"),
            ("Zm9v", "foo"),
            ("Zm9vYg==", "foob"),
            ("Zm9vYmE=", "fooba"),
            ("Zm9vYmFy", "foobar"),
        ] {
            assert_eq!(
                decode_base64(encoded).unwrap(),
                plain.as_bytes(),
                "{encoded}"
            );
        }
        assert_eq!(decode_base64("+/8=").unwrap(), [0xfb, 0xff]);
    }

    #[test]
    fn decode_base64_rejects_malformed_input() {
        for bad in [
            "Zg=", "Zg=a", "Z===", "Zm9v!A==", "Zh==", "Zm9=", "Zg==Zm9v",
        ] {
            assert!(decode_base64(bad).is_err(), "{bad}");
        }
    }

    fn recorded(values: Value) -> Value {
        json!({
            "addresses": ["A1", "A2"],
            "response": {"jsonrpc": "2.0", "result": {"context": {"slot": 7}, "value": values}}
        })
    }

    #[test]
    fn accounts_from_rpc_keeps_present_accounts_and_skips_missing_ones() {
        let r = accounts_from_rpc(&recorded(json!([
            {"owner": "P", "data": ["AQID", "base64"], "lamports": 1},
            null
        ])))
        .unwrap();
        assert_eq!(r.slot, Some(7));
        assert_eq!(r.accounts.len(), 1);
        assert_eq!(r.accounts["A1"].owner, "P");
        assert_eq!(r.accounts["A1"].data, [1, 2, 3]);
    }

    #[test]
    fn accounts_from_rpc_rejects_inconsistent_snapshots() {
        assert!(accounts_from_rpc(&recorded(json!([null]))).is_err());
        assert!(
            accounts_from_rpc(&recorded(
                json!([{"owner": "P", "data": ["AQID", "base58"]}, null])
            ))
            .is_err()
        );
        assert!(accounts_from_rpc(&recorded(json!([{"data": ["AQID", "base64"]}, null]))).is_err());
        assert!(accounts_from_rpc(&json!({"addresses": []})).is_err());
        let twice = json!({
            "addresses": ["A1", "A1"],
            "response": {"result": {"value": [
                {"owner": "P", "data": ["", "base64"]},
                {"owner": "P", "data": ["", "base64"]}
            ]}}
        });
        assert!(accounts_from_rpc(&twice).is_err());
    }
}
