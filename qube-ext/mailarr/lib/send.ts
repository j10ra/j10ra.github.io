import type { DatabaseSync } from "node:sqlite";
import { connect, type TLSSocket } from "node:tls";
import {
  getItem,
  getRoutine,
  getRun,
  hasSentCompany,
  recordSent,
  sentTodayCount,
} from "./db.js";
import { COMMERCIAL_TERMS_TOKEN, validatePitch, validateSubject } from "./validate.js";

export interface CommercialSettings {
  hourlyFloor: string;
  targetRate: string;
  premiumBand: string;
  weeklyHours: string;
}

export interface SmtpSettings {
  user: string;
  password: string;
  fromAddress: string;
}

export interface SendRequest {
  db: DatabaseSync;
  itemId: number;
  runId: number;
  to: string;
  subject: string;
  draft: string;
  commercial: CommercialSettings;
  smtp: SmtpSettings;
  dryRun: boolean;
  now?: Date;
  deliver?: (message: { from: string; to: string; subject: string; text: string }) => Promise<void>;
}

export interface SendResult {
  dryRun: boolean;
  body: string;
  sentAt: string;
}

let sendQueue = Promise.resolve();

export function formatCommercialTerms(settings: CommercialSettings): string {
  const values = [
    settings.hourlyFloor,
    settings.targetRate,
    settings.premiumBand,
    settings.weeklyHours,
  ];

  if (values.some((value) => !value.trim())) {
    throw new Error("All commercial term settings must be configured before sending");
  }

  return [
    "Commercial terms provided by Jetz:",
    `Hourly floor: ${settings.hourlyFloor.trim()}`,
    `Target rate: ${settings.targetRate.trim()}`,
    `Premium band: ${settings.premiumBand.trim()}`,
    `Weekly hours: ${settings.weeklyHours.trim()}`,
  ].join("\n");
}

export function insertCommercialTerms(draft: string, terms: string): string {
  const occurrences = draft.split(COMMERCIAL_TERMS_TOKEN).length - 1;

  if (occurrences !== 1) {
    throw new Error(`Pitch must include ${COMMERCIAL_TERMS_TOKEN} exactly once`);
  }

  return draft.replace(COMMERCIAL_TERMS_TOKEN, () => terms);
}

export function enforceSendGuards(
  db: DatabaseSync,
  input: { itemId: number; runId: number; now?: Date },
): void {
  const item = getItem(db, input.itemId);
  const run = getRun(db, input.runId);

  if (item.routineId !== run.routineId) {
    throw new Error("Item and run do not belong to the same routine");
  }
  if (run.status !== "running") throw new Error("Send requires a running run");
  if (item.stage !== "qualified") throw new Error("Only qualified items can be contacted");

  const routine = getRoutine(db, run.routineId);
  if (sentTodayCount(db, routine.id, input.now) >= routine.dailyCap) {
    throw new Error(`Daily cap of ${routine.dailyCap} reached for ${routine.name}`);
  }
  if (hasSentCompany(db, item.company)) {
    throw new Error(`${item.company} has already been contacted`);
  }
}

export async function sendFirstContact(input: SendRequest): Promise<SendResult> {
  let release: () => void = () => {};
  const previous = sendQueue;
  sendQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    enforceSendGuards(input.db, input);
    const item = getItem(input.db, input.itemId);
    const recipient = input.to.trim().toLowerCase();

    if (item.contactEmail && recipient !== item.contactEmail.trim().toLowerCase()) {
      throw new Error("Recipient must match the item's extracted contact email");
    }

    const terms = formatCommercialTerms(input.commercial);
    const body = insertCommercialTerms(input.draft, terms);
    const postingText =
      item.origin === "scan" &&
      typeof item.payload === "object" &&
      item.payload !== null &&
      "description" in item.payload &&
      typeof item.payload.description === "string"
        ? item.payload.description
        : "";
    const validation = validatePitch({ pitch: body, postingText, commercialTerms: terms });
    const subjectValidation = validateSubject({ subject: input.subject, postingText });

    const errors = [...validation.errors, ...subjectValidation.errors];

    if (errors.length) throw new Error(errors.join("; "));
    if (!recipient) throw new Error("A recipient email is required");
    if (!input.subject.trim()) throw new Error("A subject is required");

    const deliver = input.deliver ?? ((message) => deliverSmtp(message, input.smtp));

    if (!input.dryRun) {
      await deliver({
        from: input.smtp.fromAddress,
        to: input.to,
        subject: input.subject,
        text: body,
      });
    }

    const sentAt = (input.now ?? new Date()).toISOString();
    recordSent(input.db, {
      company: item.company,
      email: input.to,
      subject: input.subject,
      body,
      sentAt,
      runId: input.runId,
      dryRun: input.dryRun,
      itemId: input.itemId,
    });

    return { dryRun: input.dryRun, body, sentAt };
  } finally {
    release();
  }
}

async function deliverSmtp(
  message: { from: string; to: string; subject: string; text: string },
  smtp: SmtpSettings,
): Promise<void> {
  if (!smtp.user || !smtp.password || !smtp.fromAddress) {
    throw new Error("SMTP credentials and from address must be configured");
  }

  for (const [name, value] of Object.entries({
    from: message.from,
    to: message.to,
    subject: message.subject,
  })) {
    if (/[\r\n]/u.test(value)) throw new Error(`${name} contains an invalid line break`);
  }

  const socket = connect({
    host: "smtp.gmail.com",
    port: 465,
    servername: "smtp.gmail.com",
    rejectUnauthorized: true,
  });
  socket.setTimeout(30_000);
  const replies = createReplyReader(socket);

  try {
    await onceSecure(socket);
    await expect(replies, [220]);
    await command(socket, replies, "EHLO mailarr.local", [250]);
    await command(socket, replies, "AUTH LOGIN", [334]);
    await command(socket, replies, Buffer.from(smtp.user).toString("base64"), [334]);
    await command(socket, replies, Buffer.from(smtp.password).toString("base64"), [235]);
    await command(socket, replies, `MAIL FROM:<${message.from}>`, [250]);
    await command(socket, replies, `RCPT TO:<${message.to}>`, [250, 251]);
    await command(socket, replies, "DATA", [354]);

    const body = message.text
      .replace(/\r?\n/gu, "\r\n")
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    const subject = `=?UTF-8?B?${Buffer.from(message.subject).toString("base64")}?=`;
    const payload = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      ".",
      "",
    ].join("\r\n");

    socket.write(payload);
    await expect(replies, [250]);
    await command(socket, replies, "QUIT", [221]);
  } finally {
    socket.end();
  }
}

async function command(
  socket: TLSSocket,
  replies: ReturnType<typeof createReplyReader>,
  value: string,
  codes: number[],
): Promise<void> {
  socket.write(`${value}\r\n`);
  await expect(replies, codes);
}

async function expect(
  replies: ReturnType<typeof createReplyReader>,
  codes: number[],
): Promise<void> {
  const reply = await replies.next();

  if (!codes.includes(reply.code)) {
    throw new Error(`SMTP ${reply.code}: ${reply.lines.join(" ")}`);
  }
}

function onceSecure(socket: TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("SMTP connection timed out")));
  });
}

function createReplyReader(socket: TLSSocket) {
  type Reply = { code: number; lines: string[] };
  let buffer = "";
  let current: string[] = [];
  const ready: Reply[] = [];
  const waiting: Array<{ resolve: (reply: Reply) => void; reject: (error: Error) => void }> = [];

  const flush = (reply: Reply) => {
    const waiter = waiting.shift();

    if (waiter) waiter.resolve(reply);
    else ready.push(reply);
  };

  const fail = (error: Error) => {
    while (waiting.length) waiting.shift()?.reject(error);
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let boundary = buffer.indexOf("\r\n");

    while (boundary !== -1) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      current.push(line);

      const final = line.match(/^(\d{3}) /u);
      if (final) {
        flush({ code: Number(final[1]), lines: current });
        current = [];
      }

      boundary = buffer.indexOf("\r\n");
    }
  });
  socket.on("error", (error) => fail(error));
  socket.on("timeout", () => fail(new Error("SMTP connection timed out")));
  socket.on("close", () => fail(new Error("SMTP connection closed")));

  return {
    next: () =>
      new Promise<Reply>((resolve, reject) => {
        const reply = ready.shift();

        if (reply) resolve(reply);
        else waiting.push({ resolve, reject });
      }),
  };
}
