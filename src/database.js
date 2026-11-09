import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function createDatabase(databasePath) {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      number TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'usd',
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid', 'Paid')),
      stripe_checkout_session_id TEXT UNIQUE,
      paid_at TEXT,
      receipt_path TEXT,
      receipt_emailed_at TEXT,
      receipt_pdf BLOB,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS invoices_user_id_idx ON invoices(user_id);

    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const invoiceColumns = sqlite.prepare("PRAGMA table_info(invoices)").all();
  if (!invoiceColumns.some((column) => column.name === "receipt_pdf")) {
    sqlite.exec("ALTER TABLE invoices ADD COLUMN receipt_pdf BLOB");
  }

  return {
    async createUser({ name, email, passwordHash }) {
      try {
        const result = sqlite.prepare(
          "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
        ).run(name, email, passwordHash);
        return { id: Number(result.lastInsertRowid), name, email };
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw Object.assign(new Error("An account with that email already exists."), {
            code: "DUPLICATE_EMAIL"
          });
        }
        throw error;
      }
    },

    async findUserByEmail(email) {
      const user = sqlite.prepare(
        "SELECT id, name, email, password_hash AS passwordHash FROM users WHERE email = ?"
      ).get(email);
      return user ? { ...user, id: Number(user.id) } : null;
    },

    async findUserById(id) {
      return sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id) ?? null;
    },

    async createInvoice({ userId, number, description, amountCents, dueDate }) {
      const result = sqlite.prepare(`
        INSERT INTO invoices (user_id, number, description, amount_cents, due_date)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, number, description, amountCents, dueDate);
      return this.findInvoiceById(Number(result.lastInsertRowid), userId);
    },

    async listInvoices(userId) {
      return sqlite.prepare(`
        SELECT id, user_id AS userId, number, description, amount_cents AS amountCents,
               currency, due_date AS dueDate, status, paid_at AS paidAt,
               receipt_pdf AS receiptPdf, receipt_emailed_at AS receiptEmailedAt,
               created_at AS createdAt
        FROM invoices WHERE user_id = ? ORDER BY created_at DESC, id DESC
      `).all(userId).map(normalizeInvoice);
    },

    async findInvoiceById(id, userId) {
      const invoice = sqlite.prepare(`
        SELECT id, user_id AS userId, number, description, amount_cents AS amountCents,
               currency, due_date AS dueDate, status, paid_at AS paidAt,
               stripe_checkout_session_id AS sessionId, receipt_pdf AS receiptPdf,
               receipt_emailed_at AS receiptEmailedAt, created_at AS createdAt
        FROM invoices WHERE id = ? AND user_id = ?
      `).get(id, userId);
      return invoice ? normalizeInvoice(invoice) : null;
    },

    async linkCheckoutSession(id, userId, sessionId) {
      sqlite.prepare(`
        UPDATE invoices SET stripe_checkout_session_id = ?
        WHERE id = ? AND user_id = ? AND status = 'Unpaid'
      `).run(sessionId, id, userId);
    },

    async findInvoiceForPayment(id, userId) {
      return this.findInvoiceById(id, userId);
    },

    async markInvoicePaid(id, userId, sessionId) {
      sqlite.prepare(`
        UPDATE invoices SET status = 'Paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND user_id = ? AND stripe_checkout_session_id = ?
      `).run(id, userId, sessionId);
      return this.findInvoiceById(id, userId);
    },

    async getReceiptForUser(id, userId) {
      const invoice = sqlite.prepare(`
        SELECT status, receipt_pdf AS receiptPdf, receipt_emailed_at AS receiptEmailedAt
        FROM invoices WHERE id = ? AND user_id = ?
      `).get(id, userId);
      return invoice ? { ...invoice, receiptPdf: asBuffer(invoice.receiptPdf) } : null;
    },

    async saveReceipt(id, userId, receiptPdf) {
      sqlite.prepare(`
        UPDATE invoices SET receipt_pdf = COALESCE(receipt_pdf, ?)
        WHERE id = ? AND user_id = ? AND status = 'Paid'
      `).run(receiptPdf, id, userId);
    },

    async markReceiptEmailed(id, userId) {
      sqlite.prepare(`
        UPDATE invoices SET receipt_emailed_at = COALESCE(receipt_emailed_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND user_id = ?
      `).run(id, userId);
    },

    async claimWebhookEvent(id, eventType) {
      const existing = sqlite.prepare("SELECT status FROM stripe_webhook_events WHERE id = ?").get(id);
      if (existing?.status === "processed") return { skip: true };
      sqlite.prepare(`
        INSERT INTO stripe_webhook_events (id, event_type, status)
        VALUES (?, ?, 'processing')
        ON CONFLICT(id) DO UPDATE SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      `).run(id, eventType);
      return { skip: false };
    },

    async completeWebhookEvent(id, eventType) {
      sqlite.prepare(`
        INSERT INTO stripe_webhook_events (id, event_type, status)
        VALUES (?, ?, 'processed')
        ON CONFLICT(id) DO UPDATE SET status = 'processed', updated_at = CURRENT_TIMESTAMP
      `).run(id, eventType);
    },

    close() {
      sqlite.close();
    }
  };
}

function normalizeInvoice(invoice) {
  return { ...invoice, id: Number(invoice.id), userId: Number(invoice.userId),
    receiptPdf: asBuffer(invoice.receiptPdf) };
}

function asBuffer(value) {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
