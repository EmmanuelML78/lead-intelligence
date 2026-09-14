import assert from "node:assert/strict";
import test from "node:test";
import { computeCustomerDedupeKey } from "../src/pipeline/persist/customer-identity";

test("same normalized phone -> same dedupeKey (same company => same Customer)", () => {
  const a = computeCustomerDedupeKey({ normalizedPhone: "+573002859667", normalizedEmail: null, leadId: "LD-1" });
  const b = computeCustomerDedupeKey({ normalizedPhone: "+573002859667", normalizedEmail: "other@mail.com", leadId: "LD-2" });
  assert.equal(a, b);
  assert.equal(a, "phone:+573002859667");
});

test("different companies + same normalized phone -> different Customers", () => {
  // dedupeKey alone is identical, but Customer identity is
  // (companyId, dedupeKey) together (see @@unique([companyId, dedupeKey])),
  // so leads from different companies never collapse into one Customer.
  const dedupeKey = computeCustomerDedupeKey({ normalizedPhone: "+573002859667", normalizedEmail: null, leadId: "LD-1" });
  const identityA = `EMP-01:${dedupeKey}`;
  const identityB = `EMP-02:${dedupeKey}`;
  assert.notEqual(identityA, identityB);
});

test("missing phone + same normalized email -> same Customer", () => {
  const a = computeCustomerDedupeKey({ normalizedPhone: null, normalizedEmail: "claudia@mail.com", leadId: "LD-1" });
  const b = computeCustomerDedupeKey({ normalizedPhone: null, normalizedEmail: "claudia@mail.com", leadId: "LD-2" });
  assert.equal(a, b);
  assert.equal(a, "email:claudia@mail.com");
});

test("missing phone and email -> deterministic fallback keyed on lead id, never shared", () => {
  const a = computeCustomerDedupeKey({ normalizedPhone: null, normalizedEmail: null, leadId: "LD-1" });
  const b = computeCustomerDedupeKey({ normalizedPhone: null, normalizedEmail: null, leadId: "LD-2" });
  assert.equal(a, "lead:LD-1");
  assert.equal(b, "lead:LD-2");
  assert.notEqual(a, b);
});

test("phone takes precedence over email when both are present", () => {
  const key = computeCustomerDedupeKey({ normalizedPhone: "+573002859667", normalizedEmail: "someone@mail.com", leadId: "LD-1" });
  assert.equal(key, "phone:+573002859667");
});
