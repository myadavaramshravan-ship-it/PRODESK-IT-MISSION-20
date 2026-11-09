import { MongoClient } from "mongodb";

export async function createMongoDatabase(uri, databaseName) {
  if (!uri) throw new Error("MONGODB_URI must be configured.");
  const client = new MongoClient(uri);
  await client.connect();
  const database = client.db(databaseName || undefined);
  const users = database.collection("users");
  const invoices = database.collection("invoices");
  const events = database.collection("stripe_webhook_events");
  const counters = database.collection("counters");

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    invoices.createIndex({ userId: 1, createdAt: -1 }),
    invoices.createIndex({ stripeCheckoutSessionId: 1 }, { unique: true, sparse: true })
  ]);

  async function nextId(name) {
    const counter = await counters.findOneAndUpdate(
      { _id: name },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    return counter.sequence;
  }

  return {
    async createUser({ name, email, passwordHash }) {
      const user = { _id: await nextId("users"), name, email, passwordHash };
      try {
        await users.insertOne(user);
      } catch (error) {
        if (error.code === 11000) {
          throw Object.assign(new Error("An account with that email already exists."), {
            code: "DUPLICATE_EMAIL"
          });
        }
        throw error;
      }
      return { id: user._id, name, email };
    },

    async findUserByEmail(email) {
      const user = await users.findOne({ email }, { projection: { _id: 1, name: 1, email: 1, passwordHash: 1 } });
      return user ? { id: user._id, name: user.name, email: user.email, passwordHash: user.passwordHash } : null;
    },

    async findUserById(id) {
      const user = await users.findOne({ _id: id }, { projection: { _id: 1, name: 1, email: 1 } });
      return user ? { id: user._id, name: user.name, email: user.email } : null;
    },

    async createInvoice({ userId, number, description, amountCents, dueDate }) {
      const invoice = {
        _id: await nextId("invoices"),
        userId,
        number,
        description,
        amountCents,
        currency: "usd",
        dueDate,
        status: "Unpaid",
        paidAt: null,
        receiptPdf: null,
        receiptEmailedAt: null,
        createdAt: new Date().toISOString()
      };
      await invoices.insertOne(invoice);
      return toInvoice(invoice);
    },

    async listInvoices(userId) {
      const results = await invoices.find({ userId }).sort({ createdAt: -1, _id: -1 }).toArray();
      return results.map(toInvoice);
    },

    async findInvoiceById(id, userId) {
      const invoice = await invoices.findOne({ _id: id, userId });
      return invoice ? toInvoice(invoice) : null;
    },

    async linkCheckoutSession(id, userId, sessionId) {
      await invoices.updateOne(
        { _id: id, userId, status: "Unpaid" },
        { $set: { stripeCheckoutSessionId: sessionId } }
      );
    },

    async findInvoiceForPayment(id, userId) {
      return this.findInvoiceById(id, userId);
    },

    async markInvoicePaid(id, userId, sessionId) {
      await invoices.updateOne(
        { _id: id, userId, stripeCheckoutSessionId: sessionId, paidAt: null },
        { $set: { status: "Paid", paidAt: new Date().toISOString() } }
      );
      const invoice = await invoices.findOne({ _id: id, userId, stripeCheckoutSessionId: sessionId });
      if (!invoice) return null;
      return toInvoice(invoice);
    },

    async getReceiptForUser(id, userId) {
      const invoice = await invoices.findOne(
        { _id: id, userId },
        { projection: { status: 1, receiptPdf: 1, receiptEmailedAt: 1 } }
      );
      return invoice ? {
        status: invoice.status,
        receiptPdf: toBuffer(invoice.receiptPdf),
        receiptEmailedAt: invoice.receiptEmailedAt ?? null
      } : null;
    },

    async saveReceipt(id, userId, receiptPdf) {
      await invoices.updateOne(
        { _id: id, userId, status: "Paid", receiptPdf: null },
        { $set: { receiptPdf } }
      );
    },

    async markReceiptEmailed(id, userId) {
      await invoices.updateOne(
        { _id: id, userId, receiptEmailedAt: null },
        { $set: { receiptEmailedAt: new Date().toISOString() } }
      );
    },

    async claimWebhookEvent(id, eventType) {
      const existing = await events.findOne({ _id: id });
      if (existing?.status === "processed") return { skip: true };
      await events.updateOne(
        { _id: id },
        { $set: { eventType, status: "processing", updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
      return { skip: false };
    },

    async completeWebhookEvent(id, eventType) {
      await events.updateOne(
        { _id: id },
        { $set: { eventType, status: "processed", updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    },

    close() {
      return client.close();
    }
  };
}

function toInvoice(invoice) {
  return {
    id: invoice._id,
    userId: invoice.userId,
    number: invoice.number,
    description: invoice.description,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    dueDate: invoice.dueDate ?? null,
    status: invoice.status,
    paidAt: invoice.paidAt ?? null,
    sessionId: invoice.stripeCheckoutSessionId ?? null,
    receiptPdf: toBuffer(invoice.receiptPdf),
    receiptEmailedAt: invoice.receiptEmailedAt ?? null,
    createdAt: invoice.createdAt
  };
}

function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value.value === "function") return value.value(true);
  return Buffer.from(value);
}
