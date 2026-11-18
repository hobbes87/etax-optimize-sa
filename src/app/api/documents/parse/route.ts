import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { parseDocument } from "@/lib/parser";
import { scrubPersonalInformation } from "@/lib/popia-scrubber";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A file is required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseDocument(file.name, file.type, buffer);
  const scrubbed = scrubPersonalInformation(parsed.text);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return NextResponse.json({
    text: scrubbed,
    lineCount: parsed.lineCount,
    sha256,
    needsVisionFallback: parsed.lineCount === 0,
  });
}