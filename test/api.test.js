import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/server.js";
import { createDatabase } from "../src/database.js";
import { createStripeWebhookHandler } from "../src/webhook.js";

const jwtSecret = "test-only-secret-that-is-long-enough-to-use-safely";

test("invoice routes require a JWT and reject access to another user's invoice", async (t) => {
  const db = createDatabase(":memory:");
  t.after(() => db.close());
  const app = createApp({ db, jwtSecret, receiptService: { deliver: async () => {} } });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const homePage = await fetch(baseUrl);
  assert.equal(homePage.status, 200);
  assert.match(await homePage.text(), /Nexus Corporate \| Invoices/);

  const first = await db.createUser({ name: "Client A", email: "a@example.com", passwordHash: "hash" });
  const second = await db.createUser({ name: "Client B", email: "b@example.com", passwordHash: "hash" });
  const invoice = await db.createInvoice({
    userId: second.id,
    number: "NX-OTHER",
    description: "Client B invoice",
    amountCents: 5000,
    dueDate: null
  });
  const clientAToken = jwt.sign({}, jwtSecret, { subject: String(first.id), expiresIn: "1h" });

  const unauthenticated = await fetch(`${baseUrl}/api/invoices`);
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedUnknown = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(unauthenticatedUnknown.status, 401);
  const forbidden = await fetch(`${baseUrl}/api/invoices/${invoice.id}`, {
    headers: { Authorization: `Bearer ${clientAToken}` }
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "You do not have access to this invoice." });

  const forbiddenCheckout = await fetch(`${baseUrl}/api/invoices/${invoice.id}/checkout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${clientAToken}`, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(forbiddenCheckout.status, 403);
  const forbiddenReceipt = await fetch(`${baseUrl}/api/invoices/${invoice.id}/receipt`, {
    headers: { Authorization: `Bearer ${clientAToken}` }
  });
  assert.equal(forbiddenReceipt.status, 403);

  const forgedPaidInvoice = await fetch(`${baseUrl}/api/invoices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${clientAToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Client-created invoice",
      amount: 20,
      status: "Paid",
      userId: second.id
    })
  });
  assert.equal(forgedPaidInvoice.status, 201);
  const createdInvoice = (await forgedPaidInvoice.json()).invoice;
  assert.equal(createdInvoice.status, "Unpaid");
  assert.equal("userId" in createdInvoice, false);
});

test("Stripe webhook requires signature verification before payment state changes", async () => {
  const db = createDatabase(":memory:");
  try {
    const user = await db.createUser({
      name: "Client A",
      email: "a@example.com",
      passwordHash: "hash"
    });
    const invoice = await db.createInvoice({
      userId: user.id,
      number: "NX-PAID",
      description: "Verified invoice",
      amountCents: 7800,
      dueDate: null
    });
    await db.linkCheckoutSession(invoice.id, user.id, "cs_test_123");
    const stripe = {
      webhooks: {
        constructEvent(body, signature, secret) {
          if (signature !== "valid-signature" || secret !== "whsec_test" || body.toString() !== "raw") {
            throw new Error("signature mismatch");
          }
          return {
            id: "evt_test_1",
            type: "checkout.session.completed",
            data: { object: {
              id: "cs_test_123",
              payment_status: "paid",
              amount_total: 7800,
              currency: "usd",
              metadata: { invoiceId: String(invoice.id), userId: String(user.id) }
            } }
          };
        }
      }
    };
    let deliveries = 0;
    const handler = createStripeWebhookHandler({
      db,
      stripe,
      webhookSecret: "whsec_test",
      receiptService: { deliver: async () => { deliveries += 1; } }
    });
    const response = () => ({
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    });
    const resBad = response();
    await handler({ body: Buffer.from("raw"), get: () => "forged" }, resBad);
    assert.equal(resBad.statusCode, 400);
    assert.equal((await db.findInvoiceById(invoice.id, user.id)).status, "Unpaid");

    const resGood = response();
    await handler({ body: Buffer.from("raw"), get: () => "valid-signature" }, resGood);
    assert.equal(resGood.statusCode, 200);
    assert.equal((await db.findInvoiceById(invoice.id, user.id)).status, "Paid");
    assert.equal(deliveries, 1);

    const resRetry = response();
    await handler({ body: Buffer.from("raw"), get: () => "valid-signature" }, resRetry);
    assert.equal(resRetry.statusCode, 200);
    assert.equal(deliveries, 1);
  } finally {
    db.close();
  }
});
