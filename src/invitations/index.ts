import type { EmailDelivery } from "../email/index.js";

export interface InvitationEmail {
  id: string;
  email: string;
  inviterName: string;
  organizationName: string;
  role: "admin" | "member";
  link: string;
  expiresAt: Date;
}

export interface InvitationMailer {
  send(invitation: InvitationEmail): Promise<void>;
}

export function createInvitationMailer(delivery: EmailDelivery): InvitationMailer {
  return {
    send: (invitation) => {
      const role = invitation.role === "admin" ? "an admin" : "a member";
      const introduction = `${invitation.inviterName} invited you to join ${invitation.organizationName} as ${role}.`;
      const expiry = `This invitation expires at ${invitation.expiresAt.toISOString()}.`;
      return delivery.send({
        to: invitation.email,
        subject: `Join ${invitation.organizationName} on Paseo`,
        text: `${introduction}\n\nAccept the invitation: ${invitation.link}\n\n${expiry}`,
        html: `<p>${escapeHtml(introduction)}</p><p><a href="${escapeHtml(invitation.link)}">Join ${escapeHtml(invitation.organizationName)}</a></p><p>${escapeHtml(expiry)}</p>`,
        idempotencyKey: `paseo-invitation-${invitation.id}`,
      });
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
