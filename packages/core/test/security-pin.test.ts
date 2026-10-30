import test from "node:test";
import assert from "node:assert/strict";
import { lockoutMs, pinHash, randomSaltHex, sameHash, validPinShape, verifyPin } from "../src/security/pin.js";

const salt = randomSaltHex((n) => new Uint8Array(n).fill(7));

test("pin hashing is deterministic, salted and verifies", () => {
  const h = pinHash("4821", salt, 1000);
  assert.equal(h, pinHash("4821", salt, 1000));
  assert.notEqual(h, pinHash("4821", "00".repeat(16), 1000));
  assert.equal(verifyPin("4821", salt, h, 1000), true);
  assert.equal(verifyPin("4822", salt, h, 1000), false);
  assert.equal(sameHash("abcd", "abcd"), true);
  assert.equal(sameHash("abcd", "abce"), false);
});

test("pin shape rejects trivial pins", () => {
  assert.equal(validPinShape("4821"), true);
  assert.equal(validPinShape("123"), false);
  assert.equal(validPinShape("0000"), false);
  assert.equal(validPinShape("111111"), false);
  assert.equal(validPinShape("1234567890123"), false);
  assert.equal(validPinShape("12ab"), false);
});

test("lockout grows and caps", () => {
  assert.equal(lockoutMs(0), 0);
  assert.equal(lockoutMs(4), 0);
  assert.equal(lockoutMs(5), 30_000);
  assert.equal(lockoutMs(6), 60_000);
  assert.equal(lockoutMs(20), 15 * 60_000);
});
