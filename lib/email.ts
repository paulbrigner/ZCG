import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

export async function sendAuthCodeEmail(params: { email: string; otp: string }) {
  const fromEmail = process.env.SES_FROM_EMAIL;

  if (!fromEmail) {
    console.info(`Better Auth OTP for ${params.email}: ${params.otp}`);
    return;
  }

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: fromEmail,
      Destination: {
        ToAddresses: [params.email]
      },
      Content: {
        Simple: {
          Subject: {
            Data: "Your ZCG Grants Prototype sign-in code"
          },
          Body: {
            Text: {
              Data: `Use this code to sign in to the ZCG Grants Prototype: ${params.otp}`
            }
          }
        }
      }
    })
  );
}
