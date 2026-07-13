import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsedEmail = z.email().safeParse(
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : body?.email
  );

  if (!parsedEmail.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const email = parsedEmail.data;

  try {
    const existing = await auth.api.getVerificationOTP({
      query: { email, type: "sign-in" }
    });
    const otp = existing.otp ?? await auth.api.createVerificationOTP({
      body: { email, type: "sign-in" }
    });

    await auth.api.signInMagicLink({
      body: {
        callbackURL: "/dashboard",
        email,
        errorCallbackURL: "/sign-in?error=invalid-link",
        metadata: { otp },
        name: email
      },
      headers: request.headers
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Unable to prepare sign-in options", error);
    return NextResponse.json(
      { error: "Unable to send the sign-in email. Please try again." },
      { status: 502 }
    );
  }
}
