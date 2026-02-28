import { Attachment } from "discord.js";

export interface N8nResult {
  status: number;
  body: string;
}

function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith("image/")) {
    return true;
  }

  const filename = attachment.name?.toLowerCase() ?? "";
  return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/.test(filename);
}

export async function sendImagesToN8n(params: {
  webhookUrl: string;
  basicAuthUsername?: string;
  basicAuthPassword?: string;
  attachments: Attachment[];
  date?: string;
  guildId: string | null;
  channelId: string;
  authorId: string;
  messageId: string;
  note: string;
}): Promise<N8nResult> {
  const images = params.attachments.filter(isImageAttachment);
  if (images.length === 0) {
    throw new Error("No image attachments were found on this message.");
  }

  const form = new FormData();
  const attachmentMeta: Array<{ name: string; url: string; contentType: string; size: number }> = [];

  for (const [index, image] of images.entries()) {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`Failed to download image ${image.name ?? index + 1} (HTTP ${response.status}).`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = image.contentType ?? "application/octet-stream";
    const filename = image.name ?? `image-${index + 1}`;
    const blob = new Blob([arrayBuffer], { type: contentType });

    form.append(`file${index + 1}`, blob, filename);
    attachmentMeta.push({
      name: filename,
      url: image.url,
      contentType,
      size: image.size,
    });
  }

  form.append(
    "metadata",
    JSON.stringify({
      guildId: params.guildId,
      channelId: params.channelId,
      authorId: params.authorId,
      messageId: params.messageId,
      date: params.date,
      note: params.note,
      attachmentMeta,
      sentAt: new Date().toISOString(),
    }),
  );

  const headers = new Headers();
  if (params.basicAuthUsername && params.basicAuthPassword) {
    const basicToken = Buffer.from(`${params.basicAuthUsername}:${params.basicAuthPassword}`, "utf8").toString(
      "base64",
    );
    headers.set("Authorization", `Basic ${basicToken}`);
  }

  const n8nResponse = await fetch(params.webhookUrl, {
    method: "POST",
    headers,
    body: form,
  });

  const body = await n8nResponse.text();
  return { status: n8nResponse.status, body };
}
