export function createStripeWebhookHandler({ db, stripe, webhookSecret, receiptService }) {
  return async (req, res) => {
    if (!stripe || !webhookSecret) {
      return res.status(503).json({ error: "Stripe webhooks are not configured." });
    }

    let event;
    try {
      const signature = req.get("stripe-signature");
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (error) {
      return res.status(400).json({ error: `Invalid Stripe webhook signature: ${error.message}` });
    }

    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      return res.json({ received: true });
    }

    try {
      const claim = await db.claimWebhookEvent(event.id, event.type);
      if (claim.skip) return res.json({ received: true });

      const session = event.data.object;
      if (session.payment_status !== "paid") {
        await db.completeWebhookEvent(event.id, event.type);
        return res.json({ received: true });
      }

      const invoiceId = Number(session.metadata?.invoiceId);
      const userId = Number(session.metadata?.userId);
      if (!Number.isSafeInteger(invoiceId) || !Number.isSafeInteger(userId)) {
        await db.completeWebhookEvent(event.id, event.type);
        return res.json({ received: true });
      }

      const invoice = await db.findInvoiceForPayment(invoiceId, userId);
      if (!invoice || invoice.sessionId !== session.id ||
          session.amount_total !== invoice.amountCents ||
          session.currency?.toLowerCase() !== invoice.currency) {
        await db.completeWebhookEvent(event.id, event.type);
        return res.json({ received: true });
      }

      const paidInvoice = await db.markInvoicePaid(invoice.id, userId, session.id);
      if (!paidInvoice) {
        await db.completeWebhookEvent(event.id, event.type);
        return res.json({ received: true });
      }
      const user = await db.findUserById(userId);
      if (!user) throw new Error("The invoice owner no longer exists.");
      await receiptService.deliver(paidInvoice, user);
      await db.completeWebhookEvent(event.id, event.type);
      return res.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook processing failed:", error);
      return res.status(500).json({ error: "Payment was recorded, but receipt delivery failed. Stripe may retry this event." });
    }
  };
}
