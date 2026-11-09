import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createAuthHandlers, requireAuth } from "./auth.js";
import { createDatabase } from "./database.js";
import { createInvoiceRouter } from "./invoices.js";
import { createMongoDatabase } from "./mongo-database.js";
import { createMailTransport, createReceiptService } from "./receipt.js";
import { createStripeWebhookHandler } from "./webhook.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function createApp({
  db,
  jwtSecret,
  stripe = null,
  webhookSecret = null,
  receiptService,
  appUrl = "http://localhost:3000",
  publicPath = resolve(projectRoot, "public")
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());

  const auth = createAuthHandlers({ db, jwtSecret });
  app.post("/api/auth/register", express.json({ limit: "16kb" }), auth.register);
  app.post("/api/auth/login", express.json({ limit: "16kb" }), auth.login);

  app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }),
    createStripeWebhookHandler({ db, stripe, webhookSecret, receiptService }));
  app.use("/api", express.json({ limit: "32kb" }));
  app.use("/api", requireAuth(jwtSecret));
  app.get("/api/me", async (req, res) => {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account no longer exists." });
    return res.json({ user });
  });
  app.use("/api/invoices", createInvoiceRouter({
    express, db, stripe, appUrl, requireAuth: requireAuth(jwtSecret)
  }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));

  app.use(express.static(publicPath, { index: "index.html" }));
  app.use((error, _req, res, _next) => {
    console.error("Request failed:", error);
    if (res.headersSent) return;
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });
  return app;
}

async function start() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set to a secret of at least 32 characters.");
  }

  const db = process.env.MONGODB_URI
    ? await createMongoDatabase(process.env.MONGODB_URI, process.env.MONGODB_DATABASE)
    : createDatabase(process.env.DATABASE_PATH ?? "./data/nexus.sqlite");
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const mailTransport = createMailTransport(process.env);
  const receiptService = createReceiptService({
    db,
    mailTransport,
    mailFrom: process.env.SMTP_FROM || process.env.SMTP_USER
  });
  const app = createApp({
    db,
    jwtSecret,
    stripe,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    receiptService,
    appUrl: process.env.APP_URL ?? "http://localhost:3000"
  });
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`Nexus Corporate running on port ${port}`));
  const shutdown = () => server.close(() => {
    Promise.resolve(db.close()).finally(() => process.exit(0));
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error("Unable to start Nexus Corporate:", error);
    process.exitCode = 1;
  });
}
