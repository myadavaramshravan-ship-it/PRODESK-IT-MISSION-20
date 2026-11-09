import { randomUUID } from "node:crypto";

export function createInvoiceRouter({ express, db, stripe, appUrl, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const invoices = await db.listInvoices(req.user.id);
    return res.json({ invoices: invoices.map(publicInvoice) });
  });

  router.post("/", async (req, res) => {
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const amount = req.body?.amount;
    const dueDate = req.body?.dueDate ?? null;
    const amountCents = typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : 0;
    if (!description || description.length > 500 ||
        typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 ||
        amountCents < 1 ||
        (dueDate !== null && !isValidDate(dueDate))) {
      return res.status(400).json({ error: "Provide a description, positive amount, and optional YYYY-MM-DD due date." });
    }

    const invoice = await db.createInvoice({
      userId: req.user.id,
      number: `NX-${randomUUID().slice(0, 8).toUpperCase()}`,
      description,
      amountCents,
      dueDate
    });
    return res.status(201).json({ invoice: publicInvoice(invoice) });
  });

  router.get("/:invoiceId", async (req, res) => {
    const invoiceId = parseInvoiceId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "Invalid invoice ID." });

    const invoice = await db.findInvoiceById(invoiceId, req.user.id);
    if (!invoice) return res.status(403).json({ error: "You do not have access to this invoice." });
    return res.json({ invoice: publicInvoice(invoice) });
  });

  router.post("/:invoiceId/checkout", async (req, res, next) => {
    const invoiceId = parseInvoiceId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "Invalid invoice ID." });

    const invoice = await db.findInvoiceById(invoiceId, req.user.id);
    if (!invoice) return res.status(403).json({ error: "You do not have access to this invoice." });
    if (invoice.status === "Paid") return res.status(409).json({ error: "This invoice has already been paid." });
    if (!stripe) return res.status(503).json({ error: "Stripe payments are not configured." });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: invoice.currency,
            unit_amount: invoice.amountCents,
            product_data: { name: `Invoice ${invoice.number}`, description: invoice.description }
          }
        }],
        client_reference_id: String(invoice.id),
        metadata: { invoiceId: String(invoice.id), userId: String(req.user.id) },
        success_url: `${appUrl}/?payment=complete`,
        cancel_url: `${appUrl}/?payment=cancelled`
      });
      if (!session.url || !session.id) {
        throw new Error("Stripe did not return a checkout URL and session ID.");
      }
      await db.linkCheckoutSession(invoice.id, req.user.id, session.id);
      return res.json({ checkoutUrl: session.url });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:invoiceId/receipt", async (req, res) => {
    const invoiceId = parseInvoiceId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ error: "Invalid invoice ID." });
    const invoice = await db.getReceiptForUser(invoiceId, req.user.id);
    if (!invoice) return res.status(403).json({ error: "You do not have access to this invoice." });
    if (invoice.status !== "Paid" || !invoice.receiptPdf) {
      return res.status(404).json({ error: "The receipt is not available yet." });
    }
    return res.type("application/pdf")
      .attachment(`receipt-${invoiceId}.pdf`)
      .send(invoice.receiptPdf);
  });

  return router;
}

function parseInvoiceId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function publicInvoice(invoice) {
  return {
    id: invoice.id,
    number: invoice.number,
    description: invoice.description,
    amount: invoice.amountCents / 100,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    status: invoice.status,
    paidAt: invoice.paidAt,
    receiptAvailable: Boolean(invoice.receiptPdf),
    receiptEmailed: Boolean(invoice.receiptEmailedAt),
    createdAt: invoice.createdAt
  };
}
