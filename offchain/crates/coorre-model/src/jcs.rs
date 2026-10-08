use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

use crate::error::{ModelError, Result};
use crate::hash::sha256;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn parse(json: &str) -> Result<Value> {
    serde_json::from_str::<StrictValue>(json)
        .map(|StrictValue(value)| value)
        .map_err(|e| ModelError::InvalidJson(e.to_string()))
}

pub fn canonicalize(value: &Value) -> Result<Vec<u8>> {
    serde_json_canonicalizer::to_vec(value).map_err(|e| ModelError::Canonicalization(e.to_string()))
}

pub fn canonicalize_str(json: &str) -> Result<Vec<u8>> {
    canonicalize(&parse(json)?)
}

pub fn hash(value: &Value) -> Result<[u8; 32]> {
    Ok(sha256(&canonicalize(value)?))
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> core::result::Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an I-JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> core::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> core::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> core::result::Result<Value, E> {
        if v.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom(format!(
                "integer {v} is outside the I-JSON safe range"
            )));
        }
        Ok(Value::Number(v.into()))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> core::result::Result<Value, E> {
        if v > MAX_SAFE_INTEGER {
            return Err(E::custom(format!(
                "integer {v} is outside the I-JSON safe range"
            )));
        }
        Ok(Value::Number(v.into()))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> core::result::Result<Value, E> {
        Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> core::result::Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> core::result::Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> core::result::Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(StrictValue(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> core::result::Result<Value, A::Error> {
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate member name `{key}`")));
            }
            let StrictValue(value) = map.next_value()?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::to_hex;

    const RFC8785_SEC_3_2_2_INPUT: &str = include_str!("../tests/vectors/rfc8785/sample.json");
    const RFC8785_SEC_3_2_4_OUTPUT_HEX: &str =
        include_str!("../tests/vectors/rfc8785/sample.canonical.hex");
    const RFC8785_SEC_3_2_3_INPUT: &str = include_str!("../tests/vectors/rfc8785/sorting.json");

    #[test]
    fn canonicalize_str_matches_rfc8785_bytes() {
        let expected: Vec<u8> = RFC8785_SEC_3_2_4_OUTPUT_HEX
            .split_whitespace()
            .map(|b| u8::from_str_radix(b, 16).unwrap())
            .collect();
        assert_eq!(canonicalize_str(RFC8785_SEC_3_2_2_INPUT).unwrap(), expected);
    }

    #[test]
    fn canonicalize_sorts_properties_by_utf16_code_units() {
        let canonical =
            String::from_utf8(canonicalize_str(RFC8785_SEC_3_2_3_INPUT).unwrap()).unwrap();
        let order = [
            "Carriage Return",
            "One",
            "Control",
            "Latin Small Letter O With Diaeresis",
            "Euro Sign",
            "Emoji: Grinning Face",
            "Hebrew Letter Dalet With Dagesh",
        ];
        let positions: Vec<usize> = order.iter().map(|s| canonical.find(s).unwrap()).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{canonical}");
    }

    #[test]
    fn canonicalize_removes_whitespace_and_sorts_keys() {
        let value =
            parse("{ \"b\" : [ 1 , 2 ] ,\n \"a\" : { \"d\": true, \"c\": null } }").unwrap();
        assert_eq!(
            canonicalize(&value).unwrap(),
            br#"{"a":{"c":null,"d":true},"b":[1,2]}"#
        );
    }

    #[test]
    fn hash_is_independent_of_key_order_and_whitespace() {
        let a = parse(r#"{"x":"1","y":{"p":[1,2],"q":"z"}}"#).unwrap();
        let b = parse("{\n  \"y\": { \"q\": \"z\", \"p\": [1, 2] },\n  \"x\": \"1\"\n}").unwrap();
        assert_eq!(hash(&a).unwrap(), hash(&b).unwrap());
        assert_eq!(
            to_hex(&hash(&a).unwrap()),
            to_hex(&sha256(br#"{"x":"1","y":{"p":[1,2],"q":"z"}}"#))
        );
    }

    #[test]
    fn hash_changes_when_a_value_changes() {
        let a = parse(r#"{"x":"1"}"#).unwrap();
        let b = parse(r#"{"x":"2"}"#).unwrap();
        assert_ne!(hash(&a).unwrap(), hash(&b).unwrap());
    }

    #[test]
    fn parse_rejects_duplicate_member_names() {
        let err = parse(r#"{"a":1,"a":2}"#).unwrap_err();
        assert!(err.to_string().contains("duplicate member name"), "{err}");
        assert!(parse(r#"{"o":{"k":1,"k":1}}"#).is_err());
    }

    #[test]
    fn parse_enforces_the_safe_integer_range() {
        assert!(parse("9007199254740991").is_ok());
        assert!(parse("-9007199254740991").is_ok());
        assert!(parse("9007199254740992").is_err());
        assert!(parse("-9007199254740992").is_err());
        assert!(parse("18446744073709551615").is_err());
    }

    #[test]
    fn parse_rejects_malformed_json() {
        assert!(parse("{").is_err());
        assert!(parse(r#"{"a":1,}"#).is_err());
        assert!(parse("").is_err());
        assert!(parse("{} trailing").is_err());
    }

    #[test]
    fn parse_keeps_all_value_kinds() {
        let value = parse(r#"{"n":null,"t":true,"i":-5,"f":1.5,"s":"x","a":[{}]}"#).unwrap();
        assert_eq!(
            canonicalize(&value).unwrap(),
            br#"{"a":[{}],"f":1.5,"i":-5,"n":null,"s":"x","t":true}"#
        );
    }
}
