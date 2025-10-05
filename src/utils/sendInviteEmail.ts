// utils/sendInviteEmail.ts
import nodemailer from "nodemailer";

export const sendInviteEmail = async (
  to: string,
  name: string,
  password: string
) => {
  const transporter = nodemailer.createTransport({
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
