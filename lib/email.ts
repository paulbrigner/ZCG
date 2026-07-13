import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendAuthCodeEmail(params: { email: string; magicLink?: string; otp: string }) {
  const fromEmail = process.env.SES_FROM_EMAIL;

  if (!fromEmail) {
    console.info(`Sign-in code for ${params.email}: ${params.otp}`);
    if (params.magicLink) {
      console.info(`Sign-in link for ${params.email}: ${params.magicLink}`);
    }
    return;
  }

  const textBody = params.magicLink
    ? [
        "Use this secure link to sign in to the ZCG Grants Prototype:",
        params.magicLink,
        "",
        `Or enter this one-time code on the sign-in page: ${params.otp}`,
        "",
        "The link and code expire shortly and can each be used only once."
      ].join("\n")
    : `Use this one-time code to sign in to the ZCG Grants Prototype: ${params.otp}`;
  const htmlBody = params.magicLink
    ? `<p>Use this secure link to sign in to the ZCG Grants Prototype:</p>
       <p><a href="${escapeHtml(params.magicLink)}" style="background:#2563eb;border-radius:8px;color:#fff;display:inline-block;font-weight:700;padding:12px 18px;text-decoration:none">Sign in securely</a></p>
       <p>Or enter this one-time code on the sign-in page:</p>
       <p style="font-size:24px;font-weight:800;letter-spacing:0.12em">${escapeHtml(params.otp)}</p>
       <p>The link and code expire shortly and can each be used only once.</p>`
    : `<p>Use this one-time code to sign in to the ZCG Grants Prototype:</p>
       <p style="font-size:24px;font-weight:800;letter-spacing:0.12em">${escapeHtml(params.otp)}</p>`;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: fromEmail,
      Destination: {
        ToAddresses: [params.email]
      },
      Content: {
        Simple: {
          Subject: {
            Data: params.magicLink
              ? "Your ZCG Grants Prototype sign-in link and code"
              : "Your ZCG Grants Prototype sign-in code"
          },
          Body: {
            Text: {
              Data: textBody
            },
            Html: {
              Data: htmlBody
            }
          }
        }
      }
    })
  );
}
