import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    app: "zcg-grants-prototype",
    phase: "0",
    node: process.version,
    environment: process.env.APP_ENV ?? "unknown"
  });
}
