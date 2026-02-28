import "dotenv/config";
import { AttachmentBuilder, Client, GatewayIntentBits, Message } from "discord.js";
import { sendImagesToN8n } from "./n8n.js";
import { readRows, SheetsConfig, upsertCulvertScoresByName } from "./sheets.js";

const requiredEnv = [
  "DISCORD_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEET_ID",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const prefix = process.env.BOT_PREFIX ?? "!";
const uploadRoleId = "1104875914522808360";
const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
const n8nBasicAuthUsername = process.env.N8N_BASIC_AUTH_USERNAME;
const n8nBasicAuthPassword = process.env.N8N_BASIC_AUTH_PASSWORD;
const sheetsConfig: SheetsConfig = {
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
  privateKey: process.env.GOOGLE_PRIVATE_KEY!,
  spreadsheetId: process.env.GOOGLE_SHEET_ID!,
  sheetName: process.env.GOOGLE_SHEET_NAME ?? "Sheet1",
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function isCommand(message: Message, command: string) {
  return message.content.startsWith(`${prefix}${command}`);
}

function isValidDateParts(year: number, month: number, day: number) {
  if (year < 1000 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseN8nDate(raw: string): { isoDate: string; format: "MM/DD/YY" } | null {
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = 2000 + Number(match[3]);

  if (!isValidDateParts(year, month, day)) return null;
  return {
    isoDate: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    format: "MM/DD/YY",
  };
}

function isImageAttachment(contentType: string | null | undefined, filename: string | null | undefined) {
  if (contentType?.startsWith("image/")) return true;
  const normalized = (filename ?? "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/.test(normalized);
}

function isoToSheetDateLabel(isoDate: string) {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const month = String(Number(match[2]));
  const day = String(Number(match[3]));
  const year2 = String(Number(match[1]) % 100).padStart(2, "0");
  return `${month}/${day}/${year2}`;
}

type ExtractedEntry = {
  Name?: unknown;
  Culvert?: unknown;
  name?: unknown;
  culvert?: unknown;
};

function tryParseJsonObject(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonFromText(raw: string): unknown | null {
  const direct = tryParseJsonObject(raw);
  if (direct !== null) return direct;

  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fenced = tryParseJsonObject(fencedMatch[1].trim());
    if (fenced !== null) return fenced;
  }

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const arrayCandidate = raw.slice(firstBracket, lastBracket + 1);
    const parsedArray = tryParseJsonObject(arrayCandidate);
    if (parsedArray !== null) return parsedArray;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const objectCandidate = raw.slice(firstBrace, lastBrace + 1);
    const parsedObject = tryParseJsonObject(objectCandidate);
    if (parsedObject !== null) return parsedObject;
  }

  return null;
}

function toExtractedEntries(rawBody: string): Array<{ name: string; culvert: string }> {
  const parsed = tryParseJsonObject(rawBody);
  const payload = (parsed && typeof parsed === "object" && "output" in parsed)
    ? extractJsonFromText(String((parsed as { output?: unknown }).output ?? ""))
    : extractJsonFromText(rawBody);

  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
      ? (payload as { rows: unknown[] }).rows
      : payload && typeof payload === "object"
        ? [payload]
        : [];

  const normalized: Array<{ name: string; culvert: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as ExtractedEntry;
    const nameRaw = entry.Name ?? entry.name;
    const culvertRaw = entry.Culvert ?? entry.culvert;
    if (nameRaw == null || culvertRaw == null) continue;

    normalized.push({
      name: String(nameRaw).trim(),
      culvert: String(culvertRaw).trim(),
    });
  }

  return normalized.filter((r) => r.name && r.culvert);
}

function parseScore(raw: string) {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function normalizeUsername(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function parseSheetDate(raw: string) {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  if (!isValidDateParts(year, month, day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

async function buildUserProgressChart(username: string, labels: string[], values: number[]) {
  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `${username} Culvert`,
          data: values,
          borderColor: "#2f80ed",
          backgroundColor: "rgba(47, 128, 237, 0.15)",
          pointRadius: 3,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${username} Culvert Progression`,
        },
        legend: { display: false },
      },
      scales: {
        y: {
          title: { display: true, text: "Culvert Score" },
        },
        x: {
          title: { display: true, text: "Date" },
        },
      },
    },
  };

  const chartUrl = `https://quickchart.io/chart?width=1000&height=500&format=png&backgroundColor=white&c=${encodeURIComponent(
    JSON.stringify(chartConfig),
  )}`;
  const response = await fetch(chartUrl);
  if (!response.ok) {
    throw new Error(`Failed to render chart image (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function buildCompareChart(
  userA: string,
  userB: string,
  labels: string[],
  valuesA: Array<number | null>,
  valuesB: Array<number | null>,
) {
  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `${userA} Culvert`,
          data: valuesA,
          borderColor: "#2f80ed",
          backgroundColor: "rgba(47, 128, 237, 0.15)",
          pointRadius: 3,
          fill: false,
          tension: 0.25,
        },
        {
          label: `${userB} Culvert`,
          data: valuesB,
          borderColor: "#eb5757",
          backgroundColor: "rgba(235, 87, 87, 0.15)",
          pointRadius: 3,
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: `${userA} vs ${userB} Culvert Progression` },
        legend: { display: true },
      },
      scales: {
        y: { title: { display: true, text: "Culvert Score" } },
        x: { title: { display: true, text: "Date" } },
      },
    },
  };

  const chartUrl = `https://quickchart.io/chart?width=1100&height=550&format=png&backgroundColor=white&c=${encodeURIComponent(
    JSON.stringify(chartConfig),
  )}`;
  const response = await fetch(chartUrl);
  if (!response.ok) {
    throw new Error(`Failed to render compare chart image (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function buildCumulativeChart(labels: string[], values: number[]) {
  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Cumulative Weekly Culvert",
          data: values,
          borderColor: "#27ae60",
          backgroundColor: "rgba(39, 174, 96, 0.15)",
          pointRadius: 3,
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: "Cumulative Weekly Culvert Scores" },
        legend: { display: false },
      },
      scales: {
        y: { title: { display: true, text: "Total Score" } },
        x: { title: { display: true, text: "Week Date" } },
      },
    },
  };

  const chartUrl = `https://quickchart.io/chart?width=1100&height=550&format=png&backgroundColor=white&c=${encodeURIComponent(
    JSON.stringify(chartConfig),
  )}`;
  const response = await fetch(chartUrl);
  if (!response.ok) {
    throw new Error(`Failed to render cumulative chart image (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function getUserPoints(rows: string[][], username: string) {
  const normalizedInput = normalizeUsername(username);
  const header = rows[0] ?? [];
  const targetRow = rows
    .slice(1)
    .find((row) => normalizeUsername((row[0] ?? "").toString()) === normalizedInput);

  if (!targetRow) return null;

  const points: Array<{ label: string; date: Date; value: number }> = [];
  for (let col = 1; col < header.length; col++) {
    const label = (header[col] ?? "").toString().trim();
    const rawScore = (targetRow[col] ?? "").toString().trim();
    const date = parseSheetDate(label);
    const value = parseScore(rawScore);
    if (!date || value == null) continue;
    points.push({ label, date, value });
  }

  points.sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    displayName: String(targetRow[0]),
    points,
  };
}

function parseCompareUsers(raw: string): [string, string] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const pipeParts = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (pipeParts.length === 2) return [pipeParts[0], pipeParts[1]];

  const commaParts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaParts.length === 2) return [commaParts[0], commaParts[1]];

  const spaceParts = trimmed.split(/\s+/).filter(Boolean);
  if (spaceParts.length === 2) return [spaceParts[0], spaceParts[1]];

  return null;
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    if (isCommand(message, "upload")) {
      if (!message.inGuild() || !message.member?.roles || !("cache" in message.member.roles)) {
        await message.reply("This command can only be used in a server.");
        return;
      }

      if (!message.member.roles.cache.has(uploadRoleId)) {
        await message.reply("You do not have permission to use this command.");
        return;
      }

      if (!n8nWebhookUrl) {
        await message.reply("N8N_WEBHOOK_URL is not configured.");
        return;
      }

      const args = message.content.slice(`${prefix}upload`.length).trim();
      const tokens = args.split(/\s+/).filter(Boolean);
      const [dateToken] = tokens;
      if (!dateToken) {
        await message.reply("Date is missing. Usage: !upload MM/DD/YY (attach image(s)).");
        return;
      }
      if (tokens.length > 1) {
        await message.reply(`Usage: ${prefix}upload MM/DD/YY (no extra text)`);
        return;
      }

      const parsedDate = parseN8nDate(dateToken);
      if (!parsedDate) {
        await message.reply("Date must be valid in MM/DD/YY format.");
        return;
      }

      const imageAttachments = [...message.attachments.values()].filter((attachment) =>
        isImageAttachment(attachment.contentType, attachment.name),
      );
      if (imageAttachments.length === 0) {
        await message.reply(`Attach one or more images and run: ${prefix}upload MM/DD/YY`);
        return;
      }

      await message.reply(`Processing ${imageAttachments.length} image(s) through n8n...`);

      let writtenRows = 0;
      const failures: string[] = [];

      for (const [index, attachment] of imageAttachments.entries()) {
        try {
          const result = await sendImagesToN8n({
            webhookUrl: n8nWebhookUrl,
            basicAuthUsername: n8nBasicAuthUsername,
            basicAuthPassword: n8nBasicAuthPassword,
            attachments: [attachment],
            date: parsedDate.isoDate,
            guildId: message.guildId,
            channelId: message.channelId,
            authorId: message.author.id,
            messageId: message.id,
            note: "",
          });

          if (result.status < 200 || result.status >= 300) {
            failures.push(`#${index + 1} (${attachment.name ?? "image"}): n8n status ${result.status}`);
            continue;
          }

          const extracted = toExtractedEntries(result.body);
          if (extracted.length === 0) {
            failures.push(`#${index + 1} (${attachment.name ?? "image"}): no parsable rows in n8n response`);
            continue;
          }

          const dateLabel = isoToSheetDateLabel(parsedDate.isoDate);
          await upsertCulvertScoresByName(
            sheetsConfig,
            dateLabel,
            extracted.map((entry) => ({ name: entry.name, culvert: entry.culvert })),
          );
          writtenRows += extracted.length;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          failures.push(`#${index + 1} (${attachment.name ?? "image"}): ${messageText}`);
        }
      }

      if (failures.length === 0) {
        await message.reply(`Done. Processed ${imageAttachments.length} image(s) and wrote ${writtenRows} row(s) to Google Sheets.`);
        return;
      }

      const failurePreview = failures.slice(0, 3).join(" | ");
      await message.reply(
        `Done with partial results. Wrote ${writtenRows} row(s). Failures: ${failures.length}. ${failurePreview}`.slice(0, 1900),
      );
      return;
    }

    if (isCommand(message, "manualupload")) {
      if (!message.inGuild() || !message.member?.roles || !("cache" in message.member.roles)) {
        await message.reply("This command can only be used in a server.");
        return;
      }
      if (!message.member.roles.cache.has(uploadRoleId)) {
        await message.reply("You do not have permission to use this command.");
        return;
      }

      const args = message.content.slice(`${prefix}manualupload`.length).trim();
      if (!args) {
        await message.reply(
          `Usage: ${prefix}manualupload MM/DD/YY {"name":"user1","culvert":"63398"}`,
        );
        return;
      }

      const firstSpace = args.indexOf(" ");
      if (firstSpace === -1) {
        await message.reply("JSON payload is missing. Include a JSON object or array after the date.");
        return;
      }

      const dateToken = args.slice(0, firstSpace).trim();
      const jsonText = args.slice(firstSpace + 1).trim();
      if (!dateToken) {
        await message.reply("Date is missing.");
        return;
      }
      if (!jsonText) {
        await message.reply("JSON payload is missing. Include a JSON object or array after the date.");
        return;
      }

      const parsedDate = parseN8nDate(dateToken);
      if (!parsedDate) {
        await message.reply("Date must be valid in MM/DD/YY format.");
        return;
      }

      const manualRows = toExtractedEntries(jsonText);
      if (manualRows.length === 0) {
        await message.reply(
          "Invalid JSON payload. Provide object(s) with name/culvert keys (or Name/Culvert).",
        );
        return;
      }

      const dateLabel = isoToSheetDateLabel(parsedDate.isoDate);
      await upsertCulvertScoresByName(
        sheetsConfig,
        dateLabel,
        manualRows.map((row) => ({ name: row.name, culvert: row.culvert })),
      );
      await message.reply(`Manual upload complete. Wrote ${manualRows.length} row(s) to Google Sheets.`);
      return;
    }

    if (isCommand(message, "cumulative")) {
      const rows = await readRows(sheetsConfig, "A1:ZZ");
      if (rows.length < 2) {
        await message.reply("Sheet does not have enough data to build a cumulative chart yet.");
        return;
      }

      const header = rows[0] ?? [];
      const points: Array<{ label: string; date: Date; total: number }> = [];
      for (let col = 1; col < header.length; col++) {
        const label = (header[col] ?? "").toString().trim();
        const date = parseSheetDate(label);
        if (!date) continue;

        let total = 0;
        for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
          const rawScore = (rows[rowIndex]?.[col] ?? "").toString().trim();
          const value = parseScore(rawScore);
          if (value != null) total += value;
        }
        points.push({ label, date, total });
      }

      if (points.length === 0) {
        await message.reply("No dated score columns found in the sheet.");
        return;
      }

      points.sort((a, b) => a.date.getTime() - b.date.getTime());
      const labels = points.map((p) => p.label);
      const values = points.map((p) => p.total);
      const chartPng = await buildCumulativeChart(labels, values);
      const file = new AttachmentBuilder(chartPng, { name: "cumulative.png" });
      await message.reply({
        content: `Cumulative weekly totals (${points.length} week${points.length === 1 ? "" : "s"})`,
        files: [file],
      });
      return;
    }

    if (isCommand(message, "getuser")) {
      const username = message.content.slice(`${prefix}getuser`.length).trim();
      if (!username) {
        await message.reply(`Usage: ${prefix}getuser <username>`);
        return;
      }

      const rows = await readRows(sheetsConfig, "A1:ZZ");
      if (rows.length < 2) {
        await message.reply("Sheet does not have enough data to plot yet.");
        return;
      }

      const user = getUserPoints(rows, username);
      if (!user) {
        await message.reply(`User "${username}" was not found in the sheet.`);
        return;
      }

      if (user.points.length === 0) {
        await message.reply(`No dated score data found for "${user.displayName}".`);
        return;
      }

      const labels = user.points.map((p) => p.label);
      const values = user.points.map((p) => p.value);
      const chartPng = await buildUserProgressChart(user.displayName, labels, values);
      const file = new AttachmentBuilder(chartPng, { name: "progression.png" });

      await message.reply({
        content: `${user.displayName} progression (${user.points.length} data point${user.points.length === 1 ? "" : "s"})`,
        files: [file],
      });
      return;
    }

    if (isCommand(message, "compare")) {
      const raw = message.content.slice(`${prefix}compare`.length).trim();
      const users = parseCompareUsers(raw);
      if (!users) {
        await message.reply(`Usage: ${prefix}compare <user1>|<user2> (or comma-separated)`);
        return;
      }

      const rows = await readRows(sheetsConfig, "A1:ZZ");
      if (rows.length < 2) {
        await message.reply("Sheet does not have enough data to compare yet.");
        return;
      }

      const userA = getUserPoints(rows, users[0]);
      const userB = getUserPoints(rows, users[1]);
      if (!userA || !userB) {
        const missing = [!userA ? users[0] : null, !userB ? users[1] : null].filter(Boolean).join(", ");
        await message.reply(`User not found: ${missing}`);
        return;
      }
      if (userA.points.length === 0 || userB.points.length === 0) {
        await message.reply("One or both users have no dated score data.");
        return;
      }

      const dateMap = new Map<number, string>();
      for (const p of userA.points) dateMap.set(p.date.getTime(), p.label);
      for (const p of userB.points) dateMap.set(p.date.getTime(), p.label);
      const times = [...dateMap.keys()].sort((a, b) => a - b);
      const labels = times.map((t) => dateMap.get(t) ?? "");

      const aValueMap = new Map(userA.points.map((p) => [p.date.getTime(), p.value]));
      const bValueMap = new Map(userB.points.map((p) => [p.date.getTime(), p.value]));
      const seriesA = times.map((t) => (aValueMap.has(t) ? aValueMap.get(t)! : null));
      const seriesB = times.map((t) => (bValueMap.has(t) ? bValueMap.get(t)! : null));

      const chartPng = await buildCompareChart(userA.displayName, userB.displayName, labels, seriesA, seriesB);
      const file = new AttachmentBuilder(chartPng, { name: "comparison.png" });
      await message.reply({
        content: `${userA.displayName} vs ${userB.displayName} comparison`,
        files: [file],
      });
      return;
    }

    if (isCommand(message, "chelp")) {
      await message.reply(
        [
          `Commands:`,
          `- ${prefix}upload MM/DD/YY (attach image(s) to the same message)`,
          `- ${prefix}manualupload MM/DD/YY <json>`,
          `- ${prefix}getuser <username>`,
          `- ${prefix}compare <user1>|<user2>`,
          `- ${prefix}cumulative`,
        ].join("\n"),
      );
    }
  } catch (error) {
    console.error(error);
    await message.reply("Something went wrong while processing that command.");
  }
});

client.login(process.env.DISCORD_TOKEN);
