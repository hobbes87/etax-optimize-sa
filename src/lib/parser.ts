export type ParsedDocument = {
  text: string;
  lineCount: number;
};

export async function parseDocument(
  fileName: string,
  mimeType: string,
  data: Buffer
): Promise<ParsedDocument> {
  let text = "";

  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    const pdf = (await import("pdf-parse")).default;
    const parsed = await pdf(data);
    text = parsed.text;
  } else {
    text = data.toString("utf8");
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  return {
    text: normalized,
    lineCount: normalized ? normalized.split("\n").length : 0,
  };
}