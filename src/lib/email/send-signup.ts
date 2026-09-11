import React from 'react';
import { resend, EMAIL_FROM, isEmailEnabled } from './client';
import { SignupVerifyEmail } from './templates/signup-verify';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function sendSignupVerifyEmail(data: {
  email: string;
  companyName: string;
  verifyUrl: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Confirm your email to create your CadenzPoint workspace',
      react: React.createElement(SignupVerifyEmail, {
        companyName: data.companyName,
        verifyUrl: data.verifyUrl,
        appUrl: APP_URL,
      }),
    });
  } catch {
    // Fire-and-forget — log but never throw so signup flow isn't blocked
    console.error('Failed to send signup verification email to', data.email);
  }
}
