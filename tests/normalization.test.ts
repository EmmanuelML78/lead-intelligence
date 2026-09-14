import assert from "node:assert/strict";
import test from "node:test";
import { normalizeColombianPhone } from "../src/lib/normalization/phone";
import { normalizeChannel } from "../src/lib/normalization/channel";
import { normalizeCity } from "../src/lib/normalization/city";
import { parseMixedDate } from "../src/lib/normalization/date";

test("normalizes Colombian mobile phones", () => {
  assert.equal(normalizeColombianPhone("+57 300 285-9667").normalized, "+573002859667");
});

test("normalizes channels", () => {
  assert.equal(normalizeChannel("WHATSAPP"), "WHATSAPP");
  assert.equal(normalizeChannel("formulario web"), "WEB_FORM");
});

test("normalizes city aliases", () => {
  assert.equal(normalizeCity("B/quilla"), "Barranquilla");
  assert.equal(normalizeCity("Bogota DC"), "Bogotá");
});

test("parses mixed dates and flags ambiguity", () => {
  assert.equal(parseMixedDate("08/18/2026 17:23").rule, "mdy_slash");
  assert.equal(parseMixedDate("03/08/2026 10:30").ambiguous, true);
});
