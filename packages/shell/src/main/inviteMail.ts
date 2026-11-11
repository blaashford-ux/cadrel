/**
 * The email that carries an invitation, as a `mailto:` link the person's own mail app opens, ready to send. Cadrel sends nothing itself: it
 * comes from their address, and they press Send. The link is only ever built here, from an address and a Cadrel invitation link that are
 * checked first, so nothing else can be made to open in their mail app.
 */
import { inviteEmailText, INVITE_LINK } from '@cadrel/kernel';

const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
/** Whether this is something an email can be sent from here: one address, with no room to add another recipient. */
export const isEmailAddress = (v: string): boolean => ADDRESS.test(String(v ?? '').trim());

export function inviteMailto(to: string, link: string, studioName: string, senderName?: string): string {
  const address = String(to ?? '').trim();
  if (!isEmailAddress(address)) throw new Error('That is not an email address.');
  const url = String(link ?? '').trim();
  if (!INVITE_LINK.test(url)) throw new Error('That is not a Cadrel invitation link.');
  const { subject, body } = inviteEmailText({ studio: studioName, link: url, ...(senderName ? { sender: senderName } : {}) });
  return `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
