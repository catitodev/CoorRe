import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { HEDERA_ROOT, REPO_ROOT, isInside, realPathOf } from "../lib/paths.mjs";

test("a path is inside a directory only below it", () => {
  assert.equal(isInside(REPO_ROOT, join(REPO_ROOT, "hedera", "x.json")), true);
  assert.equal(isInside(REPO_ROOT, REPO_ROOT), true);
  assert.equal(isInside(REPO_ROOT, `${REPO_ROOT}-other${sep}x.json`), false);
  assert.equal(isInside(REPO_ROOT, join(tmpdir(), "coorre-outside", "x.json")), false);
});

test("a link from outside into the repository counts as inside", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "coorre-paths-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(HEDERA_ROOT, join(outside, "link"), "dir");
  assert.equal(isInside(REPO_ROOT, join(outside, "link", "records", "host.json")), true);
  assert.equal(isInside(REPO_ROOT, join(outside, "link", "..", "elsewhere", "host.json")), false);
  await mkdir(join(outside, "real"));
  await symlink(join(HEDERA_ROOT, "lib"), join(outside, "real", "lib"), "dir");
  assert.equal(isInside(REPO_ROOT, `${outside}${sep}real${sep}lib${sep}..${sep}x.json`), true);
  assert.equal(realPathOf(join(outside, "link", "missing", "file.json")), join(HEDERA_ROOT, "missing", "file.json"));
});

test("a dangling link is refused instead of being treated as a missing file", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "coorre-paths-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(join(outside, "nowhere"), join(outside, "dangling"));
  assert.throws(() => isInside(REPO_ROOT, join(outside, "dangling")), /dangling link is refused/);
});
