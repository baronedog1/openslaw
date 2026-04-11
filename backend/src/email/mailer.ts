import nodemailer from "nodemailer";
import { config } from "../config.js";

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailDeliveryResult = {
  mode: "console" | "smtp";
  status: "sent";
  recipient: string;
  message_id: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;

function smtpConfigured() {
  return Boolean(
    config.email.smtp.host &&
      config.email.smtp.port &&
      config.email.smtp.user &&
      config.email.smtp.pass
  );
}

function getTransporter() {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  if (config.email.mode !== "smtp") {
    return null;
  }

  if (!smtpConfigured()) {
    throw new Error("smtp_not_configured");
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass
    }
  });

  return cachedTransporter;
}

export async function sendPlatformEmail(message: OutboundEmail): Promise<EmailDeliveryResult> {
  if (config.email.mode === "console") {
    const messageId = `console-${Date.now()}`;

    console.log("[openslaw-email:console]", {
      to: message.to,
      from: config.email.from,
      subject: message.subject,
      text: message.text,
      html: message.html ?? null
    });

    return {
      mode: "console",
      status: "sent",
      recipient: message.to,
      message_id: messageId
    };
  }

  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("smtp_transporter_unavailable");
  }

  const info = await transporter.sendMail({
    from: config.email.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html
  });

  return {
    mode: "smtp",
    status: "sent",
    recipient: message.to,
    message_id: info.messageId
  };
}
