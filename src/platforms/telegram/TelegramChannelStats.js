/**
 * Channel audience numbers over MTProto: the subscriber count of a channel
 * and the joins counted on each of its invite links.
 *
 * Invite links are readable only for a channel the session administers
 * (messages.getAdminsWithInvites + messages.getExportedChatInvites). Without
 * admin rights the subscriber count is still returned and `invites` is null
 * with a reason in `invites_error`.
 */

const PAGE = 100;
const MAX_PAGES = 10;

/**
 * @param {object} client connected GramJS client
 * @param {string} channel username or "-100…" id, as used for getMessages
 * @param {{ Api?: object }} [deps] GramJS Api namespace (test seam)
 * @returns {Promise<{ subscribers: number|null,
 *   invites: Array<{ link: string, title: string|null, joins: number, requested: number,
 *                    revoked: boolean, created_at: Date|null }>|null,
 *   invites_error?: string }>}
 */
export async function readChannelStats(client, channel, { Api } = {}) {
  Api ??= (await import('telegram')).Api;
  const peer = await client.getInputEntity(channel);

  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
  const subscribers = toInt(full?.fullChat?.participantsCount);

  try {
    return { subscribers, invites: await readInvites(client, peer, Api) };
  } catch (error) {
    const reason = String(error?.errorMessage ?? error?.message ?? error);
    const adminRequired = /ADMIN|RIGHT|FORBIDDEN/i.test(reason);
    return {
      subscribers, invites: null, invites_admin_required: adminRequired,
      invites_error: adminRequired ? `invite links need admin rights in the channel (${reason})` : reason,
    };
  }
}

async function readInvites(client, peer, Api) {
  const { admins = [] } = await client.invoke(new Api.messages.GetAdminsWithInvites({ peer }));
  const byLink = new Map();
  for (const admin of admins) {
    for (const revoked of [false, true]) {
      const count = revoked ? admin.revokedInvitesCount : admin.invitesCount;
      if (!toInt(count)) continue;
      let offset = {};
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.invoke(new Api.messages.GetExportedChatInvites({
          peer, adminId: admin.adminId, revoked, limit: PAGE, ...offset,
        }));
        const invites = Array.from(result?.invites ?? []).filter(invite => invite?.link);
        for (const invite of invites) byLink.set(invite.link, normalizeInvite(invite));
        if (invites.length < PAGE) break;
        const last = invites.at(-1);
        offset = { offsetDate: last.date, offsetLink: last.link };
      }
    }
  }
  return [...byLink.values()];
}

function normalizeInvite(invite) {
  return {
    link: String(invite.link),
    title: invite.title ? String(invite.title) : null,
    joins: toInt(invite.usage) ?? 0,
    requested: toInt(invite.requested) ?? 0,
    revoked: Boolean(invite.revoked),
    created_at: invite.date ? new Date(Number(invite.date) * 1000) : null,
  };
}

function toInt(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}
