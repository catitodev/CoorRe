# W3C vc-di-eddsa test vector B.3 (eddsa-jcs-2022)

Source: Data Integrity EdDSA Cryptosuites v1.0, W3C Recommendation 15 May 2025,
Appendix B.3 "Representation: eddsa-jcs-2022" — https://www.w3.org/TR/vc-di-eddsa/#representation-eddsa-jcs-2022

The files were extracted programmatically from the `<pre>` blocks of the published
HTML (retrieved 2026-10-08, sha256 of the page
`d404f372131a0e237d85aa3a6887aa54acadb862714d73e7b001ba789b5716eb`), without manual edits:

| File | Example |
|---|---|
| `credential.json` | Example 30: Credential without Proof |
| `canonical-credential.json` | Example 31: Canonical Credential without Proof (no trailing newline) |
| `proof-options.json` | Example 33: Proof Options Document |
| `canonical-proof-options.json` | Example 34: Canonical Proof Options Document (no trailing newline) |
| `signed-credential.json` | Example 39: Signed Credential |

Keys (Example 29), hashes (Examples 32, 35, 36) and signature (Examples 37, 38) are
constants in `tests/w3c_vc_di_eddsa_b3.rs`, named `EXnn_*` after their example number.
