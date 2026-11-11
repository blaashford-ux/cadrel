/**
 * The email that carries an invitation: its subject and text, the same whether the Studio's server sends it or the owner's own mail app opens
 * with it ready. Plain text only, so there is nothing to render and nothing to be mistaken for a link but the invitation itself.
 */
export const INVITE_LINK = /^cadrel(?:-reader)?:\/\/join\?[^\s]+$/i;

export function inviteEmailText(o: { studio: string; link: string; sender?: string }): { subject: string; body: string } {
  const reader = /^cadrel-reader:/i.test(o.link);
  const app = reader ? 'Cadrel Reader' : 'Cadrel';
  const studio = (o.studio ?? '').trim().slice(0, 80) || 'my Studio';
  const sender = (o.sender ?? '').trim().slice(0, 80);
  return {
    subject: `You are invited to ${studio} on ${app}`,
    body: [
      'Hello,',
      '',
      `${sender ? `${sender} has` : 'You have been'} invited you to join ${studio} on ${app}.`,
      '',
      `1. Install ${app} if you do not have it yet.`,
      '2. Open this link, or choose "Open invitation…" in the app and paste it:',
      '',
      o.link,
      '',
      'The link works once and expires in 7 days. You will see nothing in the Studio until you have been given access to a project.'
    ].join('\r\n')
  };
}
