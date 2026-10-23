import React from 'react';
import { deliverEmail, type SendOutcome } from './send';
import { SignupVerifyEmail } from './templates/signup-verify';
import { WorkspaceReadyEmail } from './templates/workspace-ready';

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

/** Founder-provisioned waitlist signup (feature-plan-launch-blockers.md P5): the workspace is ready — set a password. */
export async function sendWorkspaceReadyEmail(data: {
  email: string;
  companyName: string;
  workspaceHost: string;
  setPasswordUrl: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'workspace-ready',
    data.email,
    'Your CadenzPoint workspace is ready',
    React.createElement(WorkspaceReadyEmail, {
      companyName: data.companyName,
      workspaceHost: data.workspaceHost,
      setPasswordUrl: data.setPasswordUrl,
      appUrl: data.appUrl,
    }),
  );
}
