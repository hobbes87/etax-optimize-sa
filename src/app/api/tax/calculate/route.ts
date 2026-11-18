import { NextRequest, NextResponse } from "next/server";
import { calculateSouthAfricanTax } from "@/lib/tax-engine";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.grossIncome === undefined || Number(body.grossIncome) < 0) {
      return NextResponse.json({ error: "grossIncome must be zero or greater" }, { status: 400 });
    }
    return NextResponse.json(calculateSouthAfricanTax(body));
  } catch {
    return NextResponse.json({ error: "Invalid JSON request" }, { status: 400 });
  }
}