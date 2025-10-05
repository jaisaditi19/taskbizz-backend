"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendInviteEmail = void 0;
exports.sendTaskEmail = sendTaskEmail;
exports.sendAuthEmail = sendAuthEmail;
exports.sendPaymentReceiptEmail = sendPaymentReceiptEmail;
// src/utils/emailUtils.ts
const mailersend_1 = require("mailersend");
const mailerSend = new mailersend_1.MailerSend({
    apiKey: process.env.MAILERSEND_API_KEY,
});
const sentFrom = new mailersend_1.Sender("no-reply@taskbizz.com", "TaskBizz");
async function sendTaskEmail({ to, subject, text, html, attachments = [], }) {
    const recipients = [new mailersend_1.Recipient(to, to)];
    const emailParams = new mailersend_1.EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(subject)
        .setText(text)
        .setHtml(html);
    if (attachments.length) {
        const mapped = attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            disposition: "attachment", // ✅ required field
        }));
        emailParams.attachments = mapped;
    }
    await mailerSend.email.send(emailParams);
}
async function sendAuthEmail({ to, subject, html, text, }) {
    const recipients = [new mailersend_1.Recipient(to, to)];
    const emailParams = new mailersend_1.EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(subject)
        .setHtml(html)
        .setText(text || "");
    await mailerSend.email.send(emailParams);
}
const sendInviteEmail = async (to, name, password) => {
    const recipients = [new mailersend_1.Recipient(to, name || to)];
    const emailParams = new mailersend_1.EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject("You're invited to join TaskBizz")
        .setHtml(`
      <div style="font-family: Arial, sans-serif; color: #111827; background:#f9fafb; padding:20px;">
        <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.05);">
          <div style="background:#2563eb; padding:20px; text-align:center;">
            <h1 style="color:#ffffff; margin:0; font-size:22px;">Welcome to TaskBizz 🚀</h1>
          </div>
          <div style="padding:24px;">
            <p>Hi <strong>${name || "there"}</strong>,</p>
            <p>You have been invited to join our organization.</p>
            <p>Here are your login details:</p>
            <ul>
              <li>Email: <strong>${to}</strong></li>
              <li>Temporary Password: <strong>${password}</strong></li>
            </ul>
            <p>Please log in and verify your account to get started.</p>
            <p><strong>Important:</strong> Change your password from your profile settings after login.</p>
            <div style="text-align:center; margin-top:20px;">
              <a href="https://portal.taskbizz.com/login"
                style="background:#2563eb; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">
                Log in to TaskBizz
              </a>
            </div>
          </div>
          <div style="background:#f3f4f6; padding:12px; text-align:center; font-size:12px; color:#6b7280;">
            © ${new Date().getFullYear()} TaskBizz
          </div>
        </div>
      </div>
    `)
        .setText(`Hi ${name || "there"},\n\nYou have been invited to join our organization.\n\nLogin Details:\nEmail: ${to}\nTemporary Password: ${password}\n\nPlease log in and verify your account.\nRemember to change your password after login.`);
    await mailerSend.email.send(emailParams);
};
exports.sendInviteEmail = sendInviteEmail;
async function sendPaymentReceiptEmail({ to, paymentId, invoiceUrl, amount, currency, purpose, invoiceNumber, date, attachments = [], }) {
    const recipients = [new mailersend_1.Recipient(to, to)];
    const subject = `Your Payment Receipt — ${invoiceNumber}`;
    const text = `Hi,

Thanks for your payment. Please find your invoice attached.
Invoice Number: ${invoiceNumber}
Amount Paid: ${currency} ${amount.toFixed(2)}
Purpose: ${purpose}
Date: ${date}

You can also download it here: ${invoiceUrl}

Regards,
TaskBizz Team
`;
    const html = `
  <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:20px; color:#111827;">
    <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.05);">
      
      <div style="background:#2563eb; padding:20px; text-align:center;">
        <h1 style="color:#ffffff; margin:0; font-size:22px;">Payment Receipt</h1>
      </div>
      
      <div style="padding:24px;">
        <p>Hi,</p>
        <p>Thank you for your payment! Here are the details of your transaction:</p>
        
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">Invoice Number</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-weight:bold;">${invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">Date</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-weight:bold;">${date}</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">Amount Paid</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-weight:bold;">${currency} ${amount.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:8px;">Purpose</td>
            <td style="padding:8px; font-weight:bold;">${purpose}</td>
          </tr>
        </table>

        <p>You can download your invoice using the link below:</p>
        <p style="margin:20px 0; text-align:center;">
          <a href="${invoiceUrl}" style="background:#2563eb; color:#ffffff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">
            Download Invoice
          </a>
        </p>

        <p style="margin-top:20px;">The invoice is also attached as a PDF for your convenience.</p>
        <p>Regards,<br/>TaskBizz Team</p>
      </div>
      
      <div style="background:#f3f4f6; padding:12px; text-align:center; font-size:12px; color:#6b7280;">
        © ${new Date().getFullYear()} TaskBizz
      </div>
    </div>
  </div>
  `;
    const emailParams = new mailersend_1.EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(subject)
        .setText(text)
        .setHtml(html);
    if (attachments.length) {
        const mapped = attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            disposition: "attachment",
        }));
        emailParams.attachments = mapped;
    }
    await mailerSend.email.send(emailParams);
}
