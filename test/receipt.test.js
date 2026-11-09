import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "../src/database.js";
import { createReceiptService } from "../src/receipt.js";

test("paid receipt is saved as a PDF and emailed once", async (t) => {
  const db = createDatabase(":memory:");
  t.after(() => db.close());

  const user = await db.createUser({
    name: "Nexus Test Client",
    email: "client@example.com",
    passwordHash: "unused"
  });
  const invoice = await db.createInvoice({
    userId: user.id,
    number: "NX-RECEIPT",
    description: "Design services",
    amountCents: 12550,
    dueDate: null
  });
  await db.linkCheckoutSession(invoice.id, user.id, "cs_receipt_test");
  const paidInvoice = await db.markInvoicePaid(invoice.id, user.id, "cs_receipt_test");
  let sentMessages = 0;
  let emailedFilePath;
  const receiptService = createReceiptService({
    db,
    mailFrom: "billing@nexus.example",
    mailTransport: {
      async sendMail(message) {
        sentMessages += 1;
        assert.equal(message.to, user.email);
        emailedFilePath = message.attachments[0].content;
        assert.equal(message.attachments[0].filename, "receipt-NX-RECEIPT.pdf");
      }
    }
  });

  await receiptService.deliver(paidInvoice, user);
  assert.ok(Buffer.isBuffer(emailedFilePath));
  assert.ok(emailedFilePath.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.ok((await db.getReceiptForUser(invoice.id, user.id)).receiptEmailedAt);

  await receiptService.deliver(paidInvoice, user);
  assert.equal(sentMessages, 1);
});
