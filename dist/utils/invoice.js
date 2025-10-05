"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateInvoiceBuffer = generateInvoiceBuffer;
exports.uploadInvoiceToSpaces = uploadInvoiceToSpaces;
exports.createInvoiceAndNotify = createInvoiceAndNotify;
// src/utils/invoice.ts
const pdfkit_1 = __importDefault(require("pdfkit"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
// import { prisma } from "../prisma/coreClient";
const container_1 = require("../di/container");
const mailerSend_1 = require("./mailerSend"); // adapt if your mailer path differs
const spaces_1 = require("../config/spaces"); // <--- use spaces client
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const INVOICE_FOLDER = "invoices";
// cap presigned URL expiry to 7 days (AWS SigV4 / DO Spaces limit)
const PRESIGN_MAX = 60 * 60 * 24 * 7; // 7 days in seconds
const SIGNED_URL_EXPIRES = Math.min(Number(process.env.INVOICE_SIGNED_URL_EXPIRES ?? PRESIGN_MAX), PRESIGN_MAX);
function formatINR(amount) {
    return `₹${Number(amount || 0).toFixed(2)}`;
}
async function generateInvoiceBuffer(payment) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new pdfkit_1.default({ size: "A4", margin: 48 });
            const chunks = [];
            doc.on("data", (chunk) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", (err) => reject(err));
            // Helpers
            function formatINR(amount) {
                return `₹${Number(amount ?? 0).toFixed(2)}`;
            }
            // NOTE: use `any` here because some pdfkit type defs don't export TextOptions
            function rightText(text, x, y, options = {}) {
                // always call doc.text with explicit x,y to avoid TS overload ambiguity
                doc.text(text, x, y, { align: "right", ...options });
            }
            const meta = payment.meta ?? {};
            // Header: Company name / invoice title
            const companyName = meta.companyName ?? "TaskBizz";
            const companyAddress = meta.companyAddress ?? [];
            // Use explicit x,y coordinates for all doc.text calls that use options / alignment
            doc.fillColor("#333");
            doc.fontSize(20).font("Helvetica-Bold").text(companyName, 48, 48);
            doc.fontSize(9).font("Helvetica").text(companyAddress.join("\n"), 48, 72);
            // Divider line
            doc.moveTo(48, 130).lineTo(547, 130).stroke();
            // Invoice metadata block (right)
            const invoiceNumber = `INV-${payment.id}`;
            const invoiceDate = (payment.date ?? new Date())
                .toISOString()
                .slice(0, 10);
            //   const dueDate = meta.dueDate ?? invoiceDate;
            const status = meta.status ?? (meta.refunded ? "Refunded" : "Paid");
            const metaTop = 60;
            const rightX = 400;
            // use explicit x,y + options
            doc
                .fontSize(14)
                .font("Helvetica-Bold")
                .text("INVOICE", rightX, metaTop, { align: "right" });
            doc
                .fontSize(9)
                .font("Helvetica")
                .text(`Invoice #: ${invoiceNumber}`, rightX, metaTop + 20, {
                align: "right",
            });
            doc
                .fontSize(9)
                .font("Helvetica")
                .text(`Date: ${invoiceDate}`, rightX, metaTop + 34, { align: "right" });
            //   doc
            //     .fontSize(9)
            //     .font("Helvetica")
            //     .text(`Due: ${dueDate}`, rightX, metaTop + 48, { align: "right" });
            doc
                .fontSize(10)
                .font("Helvetica-Bold")
                .text(`Status: ${status}`, rightX, metaTop + 48, { align: "right" });
            // Billing / From blocks
            const leftColX = 48;
            const rightColX = 380;
            const blockY = 160;
            // Billed To
            const billedToName = meta.rp_name ||
                meta.rp_email ||
                meta.userEmail ||
                payment.user?.email ||
                "Customer";
            const billedToAddr = meta.rp_address && Array.isArray(meta.rp_address)
                ? meta.rp_address
                : meta.rp_address
                    ? [String(meta.rp_address)]
                    : [];
            doc
                .fontSize(10)
                .font("Helvetica-Bold")
                .text("Billed To:", leftColX, blockY);
            doc
                .font("Helvetica")
                .fontSize(9)
                .text(billedToName, leftColX, blockY + 14);
            doc.text(billedToAddr.join("\n"), leftColX, blockY + 28);
            // From (company)
            doc.fontSize(10).font("Helvetica-Bold").text("From:", rightColX, blockY);
            doc
                .font("Helvetica")
                .fontSize(9)
                .text(companyName, rightColX, blockY + 14);
            doc.text(companyAddress.join("\n"), rightColX, blockY + 28);
            // Line items table header
            const tableTop = 250;
            doc
                .moveTo(48, tableTop - 8)
                .lineTo(547, tableTop - 8)
                .stroke();
            const colDescX = 48;
            const colQtyX = 360;
            const colUnitX = 420;
            const colAmountX = 500;
            doc.fontSize(10).font("Helvetica-Bold");
            doc.text("Description", colDescX, tableTop, {
                width: colQtyX - colDescX - 8,
            });
            doc.text("Qty", colQtyX, tableTop, {
                width: colUnitX - colQtyX - 8,
                align: "right",
            });
            doc.text("Unit", colUnitX, tableTop, {
                width: colAmountX - colUnitX - 8,
                align: "right",
            });
            doc.text("Amount", colAmountX, tableTop, { align: "right" });
            doc
                .moveTo(48, tableTop + 18)
                .lineTo(547, tableTop + 18)
                .stroke();
            // Build items list: support meta.items array with {desc, qty, unitPrice, amount}
            let items = [];
            if (Array.isArray(meta.items) && meta.items.length > 0) {
                items = meta.items.map((it) => {
                    const qty = Number(it.qty ?? 1);
                    const unitPrice = Number(it.unitPrice ?? it.price ?? 0);
                    const amount = Number(it.amount ?? qty * unitPrice);
                    return { desc: String(it.desc ?? "Item"), qty, unitPrice, amount };
                });
            }
            else {
                // default single-line item fallback
                const desc = payment.purpose === "NEW_SUBSCRIPTION"
                    ? `Subscription ${meta.planId ?? "plan"} — ${meta.seats ?? 1} seat(s) — ${meta.period ?? "period"}`
                    : meta.description ?? String(payment.purpose ?? "Payment");
                const amount = Number(payment.amount ?? 0);
                items = [{ desc, qty: 1, unitPrice: amount, amount }];
            }
            // Render items rows
            doc.fontSize(9).font("Helvetica");
            let y = tableTop + 28;
            const rowHeight = 20;
            let subtotal = 0;
            for (const it of items) {
                if (y > 720) {
                    doc.addPage();
                    y = 48;
                }
                doc.text(it.desc, colDescX, y, { width: colQtyX - colDescX - 8 });
                doc.text(String(it.qty), colQtyX, y, {
                    width: colUnitX - colQtyX - 8,
                    align: "right",
                });
                doc.text(formatINR(it.unitPrice), colUnitX, y, {
                    width: colAmountX - colUnitX - 8,
                    align: "right",
                });
                doc.text(formatINR(it.amount), colAmountX, y, { align: "right" });
                subtotal += it.amount;
                y += rowHeight;
            }
            // Totals block (right side)
            const totalsTop = y + 8;
            const totalsXLabel = 360;
            const totalsXValue = 547;
            doc
                .moveTo(360, totalsTop - 6)
                .lineTo(547, totalsTop - 6)
                .stroke();
            // Taxes and adjustments
            const taxRate = Number(meta.taxRate ?? meta.gstPercent ?? 0);
            const taxAmount = Number((subtotal * taxRate) / 100 || 0);
            const adjustments = Number(meta.adjustments ?? 0);
            const total = subtotal + taxAmount + adjustments;
            doc.fontSize(9).font("Helvetica");
            // use explicit x,y + options everywhere
            doc.text("Subtotal", totalsXLabel, totalsTop, {
                width: totalsXValue - totalsXLabel - 8,
                align: "right",
            });
            rightText(formatINR(subtotal), totalsXValue, totalsTop);
            if (taxRate > 0) {
                doc.text(`Tax (${taxRate}%)`, totalsXLabel, totalsTop + 14, {
                    width: totalsXValue - totalsXLabel - 8,
                    align: "right",
                });
                rightText(formatINR(taxAmount), totalsXValue, totalsTop + 14);
            }
            if (adjustments !== 0) {
                doc.text("Adjustments", totalsXLabel, totalsTop + 28, {
                    width: totalsXValue - totalsXLabel - 8,
                    align: "right",
                });
                rightText(formatINR(adjustments), totalsXValue, totalsTop + 28);
            }
            doc.font("Helvetica-Bold").fontSize(11);
            doc.text("Total", totalsXLabel, totalsTop + 46, {
                width: totalsXValue - totalsXLabel - 8,
                align: "right",
            });
            rightText(formatINR(total), totalsXValue, totalsTop + 46);
            // Payment details section
            const paymentY = totalsTop + 90;
            //   doc
            //     .moveTo(48, paymentY - 6)
            //     .lineTo(547, paymentY - 6)
            //     .stroke();
            //   doc
            //     .fontSize(10)
            //     .font("Helvetica-Bold")
            //     .text("Payment Details", 48, paymentY);
            //   doc.fontSize(9).font("Helvetica");
            //   const bankName = meta.bankName ?? "Your Bank Name";
            //   const account = meta.account ?? "Account: 0000000000";
            //   const ifsc = meta.ifsc ?? "IFSC: XXXXX0000";
            //   const upi = meta.upi ?? "your-upi@bank";
            //   doc.text(`${bankName}`, 48, paymentY + 16);
            //   doc.text(`${account} | ${ifsc}`, 48, paymentY + 30);
            //   doc.text(`UPI: ${upi}`, 48, paymentY + 44);
            // Notes & Terms
            const notesY = paymentY + 80;
            doc
                .moveTo(48, notesY - 8)
                .lineTo(547, notesY - 8)
                .stroke();
            doc.fontSize(9).font("Helvetica-Bold").text("Notes & Terms", 48, notesY);
            doc.fontSize(8).font("Helvetica");
            const terms = meta.terms ??
                "Payment due within 7 days. Please contact billing@yourcompany.com for queries.";
            doc.text(terms, 48, notesY + 14, { width: 499 });
            // Footer
            doc
                .fontSize(8)
                .fillColor("#666")
                .text(`Invoice generated on ${new Date().toISOString().slice(0, 10)}`, 48, 770, { align: "center", width: 500 });
            doc.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
async function uploadInvoiceToSpaces(buffer, key) {
    if (!SPACES_BUCKET)
        throw new Error("SPACES_BUCKET not configured");
    await spaces_1.spaces.send(new client_s3_1.PutObjectCommand({
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: "application/pdf",
        ACL: "private",
    }));
    const getCmd = new client_s3_1.GetObjectCommand({ Bucket: SPACES_BUCKET, Key: key });
    const url = await (0, s3_request_presigner_1.getSignedUrl)(spaces_1.spaces, getCmd, {
        expiresIn: SIGNED_URL_EXPIRES,
    });
    return { key, url };
}
async function createInvoiceAndNotify(paymentId) {
    const prisma = await (0, container_1.getCorePrisma)();
    const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB safe default for email attachments
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { user: true },
    });
    if (!payment)
        throw new Error("payment not found");
    const meta = payment.meta ?? {};
    if (meta.invoiceGenerated) {
        return { skipped: true, invoiceUrl: meta.invoiceUrl ?? null };
    }
    // generate PDF buffer
    const pdfBuffer = await generateInvoiceBuffer(payment);
    // upload to Spaces (private by default)
    const key = `${INVOICE_FOLDER}/INV-${payment.id}.pdf`;
    const { url } = await uploadInvoiceToSpaces(pdfBuffer, key);
    // persist invoice meta (idempotent-ish)
    const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
            meta: {
                ...payment.meta,
                invoiceGenerated: true,
                invoiceKey: key,
                invoiceUrl: url,
                invoiceAt: new Date(),
            },
        },
    });
    // pick recipient email (safely)
    const metaAfter = updated.meta ?? {};
    const candidateEmails = [
        payment.user?.email ?? undefined,
        typeof metaAfter.rp_email === "string" ? metaAfter.rp_email : undefined,
        typeof metaAfter.email === "string" ? metaAfter.email : undefined,
        typeof metaAfter.userEmail === "string" ? metaAfter.userEmail : undefined,
    ];
    const toEmail = candidateEmails
        .find((e) => typeof e === "string" && e.trim() !== "")
        ?.trim();
    if (!toEmail) {
        console.warn(`createInvoiceAndNotify: no recipient email found for payment ${payment.id}; invoice uploaded but email not sent.`);
        return { skipped: false, invoiceUrl: url, emailSent: false };
    }
    // Decide whether to attach or fallback to link (based on size)
    const attachPdf = pdfBuffer.length <= MAX_ATTACHMENT_BYTES;
    // Prepare email fields
    const baseEmailPayload = {
        to: toEmail,
        paymentId: updated.id,
        invoiceUrl: url, // always include link as convenience
        amount: Number(updated.amount ?? 0),
        currency: String(updated.currency ?? "INR"),
        purpose: String(updated.purpose ?? "PAYMENT"),
        invoiceNumber: `INV-${updated.id}`,
        date: (updated.date ?? new Date()).toISOString().slice(0, 10),
    };
    try {
        if (attachPdf) {
            // Attach PDF (base64 conversion handled in sendPaymentReceiptEmail)
            await (0, mailerSend_1.sendPaymentReceiptEmail)({
                ...baseEmailPayload,
                attachments: [
                    {
                        filename: `INV-${updated.id}.pdf`,
                        content: pdfBuffer,
                    },
                ],
            });
            return {
                skipped: false,
                invoiceUrl: url,
                emailSent: true,
                attached: true,
            };
        }
        else {
            // Fallback: do not attach (avoid oversized emails), include presigned link in email body
            // note: presigned URL expiry is capped (7 days); but the attachment is in the user's mailbox when attached.
            await (0, mailerSend_1.sendPaymentReceiptEmail)({
                ...baseEmailPayload,
                // no attachments
            });
            console.warn(`createInvoiceAndNotify: invoice ${updated.id} exceeds ${MAX_ATTACHMENT_BYTES} bytes; sent link instead of attaching.`);
            return {
                skipped: false,
                invoiceUrl: url,
                emailSent: true,
                attached: false,
            };
        }
    }
    catch (mailErr) {
        console.warn("Failed to send invoice email", mailErr);
        return { skipped: false, invoiceUrl: url, emailSent: false, mailErr };
    }
}
