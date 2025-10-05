"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendInviteEmail = void 0;
// utils/sendInviteEmail.ts
const nodemailer_1 = __importDefault(require("nodemailer"));
const sendInviteEmail = async (to, name, password) => {
    const transporter = nodemailer_1.default.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
    const mailOptions = {
        from: `"Your App" <${process.env.SMTP_USER}>`,
        to,
        subject: "You're invited to join our organization",
        html: `
      <p>Hi ${name || "there"},</p>
      <p>You have been invited to join our organization.</p>
      <p>Here are your login details:</p>
      <ul>
        <li>Email: <strong>${to}</strong></li>
        <li>Temporary Password: <strong>${password}</strong></li>
      </ul>
      <p>Please log in and verify your account to get started.</p>
      <p>Please change the password from edit profile.</p>
    `,
    };
    await transporter.sendMail(mailOptions);
};
exports.sendInviteEmail = sendInviteEmail;
