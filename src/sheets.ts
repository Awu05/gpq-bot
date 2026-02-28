import { google } from "googleapis";

export interface SheetsConfig {
  serviceAccountEmail: string;
  privateKey: string;
  spreadsheetId: string;
  sheetName: string;
}

type CulvertScoreRow = {
  name: string;
  culvert: string;
};

function normalizeName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function findRowByName(nameToRow: Map<string, number>, inputName: string) {
  const normalizedInput = normalizeName(inputName);
  const exact = nameToRow.get(normalizedInput);
  if (exact != null) return exact;

  const partialMatches = [...nameToRow.entries()].filter(([existing]) =>
    existing.includes(normalizedInput) || normalizedInput.includes(existing),
  );

  if (partialMatches.length === 0) return null;
  // Prefer the closest-length partial match.
  partialMatches.sort(
    (a, b) => Math.abs(a[0].length - normalizedInput.length) - Math.abs(b[0].length - normalizedInput.length),
  );
  return partialMatches[0][1];
}

function getSheetsApi(config: SheetsConfig) {
  const auth = new google.auth.JWT({
    email: config.serviceAccountEmail,
    key: config.privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

export async function readRows(config: SheetsConfig, range = "A:Z") {
  const sheets = getSheetsApi(config);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!${range}`,
  });

  return response.data.values ?? [];
}

export async function appendRow(config: SheetsConfig, values: string[]) {
  await appendRows(config, [values]);
}

export async function appendRows(config: SheetsConfig, values: string[][]) {
  if (values.length === 0) return;

  const sheets = getSheetsApi(config);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values,
    },
  });
}

function columnLabel(n: number) {
  let x = n;
  let s = "";
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export async function upsertCulvertScoresByName(config: SheetsConfig, dateLabel: string, scores: CulvertScoreRow[]) {
  if (scores.length === 0) return;

  const sheets = getSheetsApi(config);
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A1:ZZ`,
  });

  const values = existing.data.values ?? [];
  if (values.length === 0) values.push([]);
  if (!values[0][0]) values[0][0] = "Name";

  const header = values[0];
  let dateCol = header.findIndex((v) => v === dateLabel);
  if (dateCol === -1) {
    dateCol = Math.max(1, header.length);
    header[dateCol] = dateLabel;
    values[0] = header;
  }

  const nameToRow = new Map<string, number>();
  for (let r = 1; r < values.length; r++) {
    const name = normalizeName((values[r]?.[0] ?? "").toString());
    if (name) nameToRow.set(name, r);
  }

  const updates: Array<{ range: string; values: string[][] }> = [];

  for (const score of scores) {
    const normalizedScoreName = normalizeName(score.name);
    let rowIdx = findRowByName(nameToRow, normalizedScoreName);
    if (rowIdx == null) {
      rowIdx = values.length;
      values.push([score.name]);
      nameToRow.set(normalizedScoreName, rowIdx);
    }

    updates.push({
      range: `${config.sheetName}!${columnLabel(dateCol + 1)}${rowIdx + 1}`,
      values: [[score.culvert]],
    });
  }

  const names = values.slice(1).map((row) => [String(row?.[0] ?? "")]);
  updates.push({
    range: `${config.sheetName}!A1`,
    values: [["Name"]],
  });
  updates.push({
    range: `${config.sheetName}!${columnLabel(dateCol + 1)}1`,
    values: [[dateLabel]],
  });
  updates.push({
    range: `${config.sheetName}!A2:A${names.length + 1}`,
    values: names,
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates,
    },
  });
}
