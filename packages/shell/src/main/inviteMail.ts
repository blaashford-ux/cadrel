/**
 * The email that carries an invitation, as a `mailto:` link the person's own mail app opens, ready to send. Cadrel sends nothing itself: it
 * comes from their address, and they press Send. The link is only ever built here, from an address and a Cadrel invitation link that are
 * checked first, so nothing else can be made to open in their mail app.
 */
const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
const LINK = /^cadrel(?:-reader)?:\/\/join\?[^\s]+$/i;

export function inviteMailto(to: string, link: string, studioName: string, senderName?: string): string {
  const address = String(to ?? '').trim();
  if (!ADDRESS.test(address)) throw new Error('That is not an email address.');
  const url = String(link ?? '').trim();
  if (!LINK.test(url)) throw new Error('That is not a Cadrel invitation link.');
  const reader = /^cadrel-reader:/i.test(url);
  const studio = String(studioName ?? '').trim().slice(0, 80) || 'my Studio';
  const subject = `You are invited to ${studio} on Cadrel`;
  const body = [
    `Hello,`,
    ``,
    `${senderName?.trim() ? `${senderName.trim()} has` : 'You have been'} invited you to join ${studio} on ${reader ? 'Cadrel Reader' : 'Cadrel'}.`,
    ``,
    `1. Install ${reader ? 'Cadrel Reader' : 'Cadrel'} if you do not have it yet.`,
    `2. Open this link, or choose "Open invitation…" in the app and paste it:`,
    ``,
    url,
    ``,
    `The link works once and expires in 7 days. You will see nothing in the Studio until you have been given access to a project.`
  ].join('\r\n');
  return `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
