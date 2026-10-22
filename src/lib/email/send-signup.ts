import React from 'react';
import { deliverEmail, type SendOutcome } from './send';
import { SignupVerifyEmail } from './templates/signup-verify';

/** Signup verification. `appUrl` is the APEX — the workspace doesn't exist yet. */
export async function sendSignupVerifyEmail(data: {
  email: string;
  companyName: string;
  verifyUrl: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'signup-verify',
    data.email,
    'Confirm your email to create your CadenzPoint workspace',
    React.createElement(SignupVerifyEmail, {
      companyName: data.companyName,
      verifyUrl: data.verifyUrl,
      appUrl: data.appUrl,
    }),
  );
}
