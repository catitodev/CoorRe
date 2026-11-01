# Hedera golden vectors

`hedera-ids.json` holds three vectors for the identifiers CoorRe uses on Hedera:

- `mandateId`: SHA-256 of the JCS form of a mandate document;
- `caseRef`: the case reference of a host period and its `case_id`, SHA-256 of the reference;
- `hcsMessage`: a decision log message in JCS form, with its size in bytes and its SHA-256.

Provenance: the expected values were computed with Python 3 (`json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` and `hashlib.sha256`), independently of the JavaScript code under test. For these inputs, which hold only ASCII strings, integers and `null`, that serialization is the RFC 8785 form. `hedera/test/vectors.test.mjs` recomputes each value with `hedera/lib`.
