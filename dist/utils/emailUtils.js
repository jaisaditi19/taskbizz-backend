"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
// src/utils/emailUtils.ts
const nodemailer_1 = __importDefault(require("nodemailer"));
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});
async function sendEmail(to, subject, html) {
    try {
        await transporter.sendMail({
            from: `"TaskBizz" <${process.env.SMTP_USER}>`,
            to,
            subject,
            html,
        });
    }
    catch (err) {
        console.error("sendEmail error:", err);
    }
}
