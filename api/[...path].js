import Stripe from "stripe";
import { createApp } from "../src/server.js";
import { createMongoDatabase } from "../src/mongo-database.js";
import { createMailTransport, createReceiptService } from "../src/receipt.js";

let appPromise;

async function initializeApp() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set to a secret of at least 32 characters.");
  }
  const db = await createMongoDatabase(process.env.MONGODB_URI, process.env.MONGODB_DATABASE);
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const receiptService = createReceiptService({
    db,
    mailTransport: createMailTransport(process.env),
    mailFrom: process.env.SMTP_FROM || process.env.SMTP_USER
  });
  return createApp({
    db,
    jwtSecret,
    stripe,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    receiptService,
    appUrl: process.env.APP_URL ?? "http://localhost:3000"
  });
}

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = initializeApp().catch((error) => {
      appPromise = null;
      throw error;
    });
  }
  const app = await appPromise;
  return app(req, res);
}
