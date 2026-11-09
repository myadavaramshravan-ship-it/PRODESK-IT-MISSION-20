import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";

export function createReceiptService({ db, mailTransport, mailFrom }) {
  return {
    async deliver(invoice, user) {
      let receipt = await db.getReceiptForUser(invoice.id, user.id);
      if (!receipt?.receiptPdf) {
        await db.saveReceipt(invoice.id, user.id, await writeReceipt(invoice, user));
        receipt = await db.getReceiptForUser(invoice.id, user.id);
      }
      if (!receipt?.receiptPdf) throw new Error("Unable to persist the generated receipt.");
      if (!mailTransport) throw new Error("SMTP is not configured; the receipt cannot be emailed.");

      if (!receipt.receiptEmailedAt) {
        await mailTransport.sendMail({
          from: mailFrom,
          to: user.email,
          subject: `Paid receipt for invoice ${invoice.number}`,
          text: `Thank you. Your payment for invoice ${invoice.number} has been received. Your receipt is attached.`,
          attachments: [{ filename: `receipt-${invoice.number}.pdf`, content: receipt.receiptPdf }]
        });
        await db.markReceiptEmailed(invoice.id, user.id);
      }
    }
  };
}

export function createMailTransport(env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid TCP port.");
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "true",
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
  });
}

function writeReceipt(invoice, user) {
  return new Promise((resolvePromise, rejectPromise) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 56 });
    const chunks = [];
    doc.on("error", rejectPromise);
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));

    doc.save();
    doc.fillColor("#102a43").roundedRect(56, 50, 42, 42, 9).fill();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(21).text("N", 56, 59, {
      width: 42,
      align: "center"
    });
    doc.restore();
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(17).text("NEXUS", 110, 54);
    doc.fillColor("#627d98").font("Helvetica").fontSize(9).text("CORPORATE", 111, 76, { characterSpacing: 1.5 });
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(28).text("Payment receipt", 56, 133);
    doc.fillColor("#627d98").font("Helvetica").fontSize(11).text(`Invoice ${invoice.number}`, 56, 174);

    doc.save();
    doc.rotate(-12, { origin: [455, 168] });
    doc.lineWidth(3).strokeColor("#16805d").roundedRect(379, 145, 126, 43, 5).stroke();
    doc.fillColor("#16805d").font("Helvetica-Bold").fontSize(24).text("PAID", 379, 154, {
      width: 126,
      align: "center"
    });
    doc.restore();

    doc.moveTo(56, 220).lineTo(556, 220).lineWidth(1).strokeColor("#d9e2ec").stroke();
    doc.fillColor("#627d98").font("Helvetica").fontSize(10).text("BILLED TO", 56, 245);
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(12).text(user.name, 56, 263);
    doc.fillColor("#486581").font("Helvetica").fontSize(10).text(user.email, 56, 282);
    doc.fillColor("#627d98").font("Helvetica").fontSize(10).text("PAYMENT DATE", 350, 245);
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(11).text(
      invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString("en-US", { dateStyle: "long" }) : "Paid",
      350, 264
    );

    doc.moveTo(56, 328).lineTo(556, 328).lineWidth(1).strokeColor("#d9e2ec").stroke();
    doc.fillColor("#627d98").font("Helvetica-Bold").fontSize(9).text("DESCRIPTION", 56, 345);
    doc.text("AMOUNT", 430, 345, { width: 126, align: "right" });
    doc.fillColor("#102a43").font("Helvetica").fontSize(11).text(invoice.description, 56, 374, { width: 340 });
    doc.font("Helvetica-Bold").text(formatMoney(invoice.amountCents, invoice.currency), 400, 374, {
      width: 156,
      align: "right"
    });
    doc.moveTo(56, 422).lineTo(556, 422).lineWidth(1).strokeColor("#d9e2ec").stroke();
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(13).text("TOTAL PAID", 56, 447);
    doc.fontSize(16).text(formatMoney(invoice.amountCents, invoice.currency), 350, 444, {
      width: 206,
      align: "right"
    });
    doc.fillColor("#627d98").font("Helvetica").fontSize(9).text(
      "Thank you for your business. This receipt confirms payment in full.",
      56, 710, { width: 500, align: "center" }
    );
    doc.end();
  });
}

function formatMoney(amountCents, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() })
    .format(amountCents / 100);
}
