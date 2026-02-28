# Discord + Google Sheets Bot (TypeScript) Powered by n8n + Ollama (Ministral 3 For OCR)

## What this does
- `!upload MM/DD/YY` sends attached images to n8n and writes parsed rows.
- `!manualupload MM/DD/YY <json>` writes manual `name/culvert` JSON rows to sheets.
- `!getuser <username>` builds a progression line graph from Google Sheet scores and returns it as an image.
- `!compare <user1>|<user2>` plots both users on one line graph and returns a PNG.
- `!cumulative` sums each week/date column and returns a line-chart PNG of totals.

## 1) Create a Discord bot
1. Go to Discord Developer Portal: https://discord.com/developers/applications
2. Create an application and add a Bot.
3. Under Bot settings:
   - Copy the bot token.
   - Enable **Message Content Intent**.
4. Invite the bot to your server with `bot` scope and message permissions.

## 2) Create Google service account access
1. In Google Cloud Console, create/select a project.
2. Enable **Google Sheets API**.
3. Create a Service Account.
4. Create a JSON key for that account.
5. Copy these fields from the JSON:
   - `client_email` -> `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` -> `GOOGLE_PRIVATE_KEY`
6. Share your target Google Sheet with the service account email.

## 3) Configure environment
1. Copy `.env.example` to `.env`.
2. Fill in values:
   - `DISCORD_TOKEN`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` (keep `\n` escaped)
   - `GOOGLE_SHEET_ID` (from sheet URL)
   - Optional: `GOOGLE_SHEET_NAME`, `BOT_PREFIX`
   - Optional for upload command: `N8N_WEBHOOK_URL`, `N8N_BASIC_AUTH_USERNAME`, `N8N_BASIC_AUTH_PASSWORD`

## 4) Install and run
```bash
npm install
npm run start
```

Dev watch mode:
```bash
npm run dev
```

Type-check/build:
```bash
npm run build
```

## 5) Run with Docker
Build and start:
```bash
docker compose up -d --build
```

View logs:
```bash
docker compose logs -f bot
```

Stop:
```bash
docker compose down
```

## Commands
- `!chelp`
- `!upload 02/27/26` with image attachment(s)
- `!manualupload 02/27/26 {"name":"user1","culvert":"63,398"}`
- `!getuser user1`
- `!compare user1|user2`
- `!cumulative`

## n8n webhook payload
- Request is sent as `multipart/form-data`.
- Each image is attached as file fields: `file1`, `file2`, ...
- A `metadata` text field contains JSON with:
  - `guildId`, `channelId`, `authorId`, `messageId`
  - `date` (from the `!upload` command)
  - `attachmentMeta` (name, url, contentType, size)
  - `sentAt`
- If n8n returns parsable JSON rows with `Name` and `Culvert`, the bot upserts by name:
  - If name exists in column A, culvert is written in the score column for the command date.
  - If name does not exist, a new row is created and then score is written.
  - Score column date comes directly from the command date.
- If multiple images are attached to `!upload`, the bot sends them to n8n one-by-one and waits for each response before sending the next image.
