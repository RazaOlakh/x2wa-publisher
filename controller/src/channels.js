// Channel discovery filtered by the account's actual posting rights.
//
// A newsletter being visible in WhatsApp Web says nothing about whether
// this account may post to it: a plain subscriber sees a channel just like
// an admin does, and `iAmAdmin`/`isCAGAdmin` on the chat model return
// false even for a channel that accepts posts (verified against the
// dedicated account - see docs). The reliable signal is the server's
// membership type, fetched per channel:
//
//   WAWebNewsletterMetadataQueryJob.queryNewsletterMetadataByJid(id)
//     .newsletterMembershipMetadataMixin.membershipType  -> 'owner' | 'admin' | ...
//
// which whatsapp-web.js itself checks with isMembershipAdminOrOwner().
// Anything we cannot verify is reported as ineligible, so a permission
// problem can never be presented as "you may post here".

const ELIGIBLE_ROLES = new Set(['owner', 'admin']);

// Runs inside the WhatsApp Web page. Kept self-contained because it is
// serialised into the browser context.
function pageProbe(channelIds) {
  return (async () => {
    const utils = window.require('WAWebNewsletterModelUtils');
    const job = window.require('WAWebNewsletterMetadataQueryJob');
    const out = [];
    for (const id of channelIds) {
      try {
        const md = await job.queryNewsletterMetadataByJid(id);
        const role = md && md.newsletterMembershipMetadataMixin && md.newsletterMembershipMetadataMixin.membershipType;
        const stateType = md && md.newsletterStateMetadataMixin && md.newsletterStateMetadataMixin.stateType;
        const name = md && md.newsletterNameMetadataMixin && md.newsletterNameMetadataMixin.nameElementValue;
        out.push({
          id,
          role: role || null,
          state: stateType || null,
          name: name || null,
          // whatsapp-web.js's own predicate for this role set.
          canPost: typeof utils.isMembershipAdminOrOwner === 'function'
            ? Boolean(utils.isMembershipAdminOrOwner(role))
            : ELIGIBLE_ROLES.has(role),
        });
      } catch (e) {
        out.push({ id, role: null, state: null, name: null, canPost: false, error: String((e && e.message) || e).slice(0, 120) });
      }
    }
    return out;
  })();
}

// Splits newsletters into "can post" and the rest, using only the server
// verdict. Pure so the eligibility rule itself can be tested.
function partitionChannels(all, verdicts) {
  const byId = new Map(all.map((c) => [c.id && (c.id._serialized || c.id.$1), c]));
  const channels = [];
  const ineligible = [];
  let degraded = false;
  for (const v of verdicts) {
    const chat = byId.get(v.id);
    const name = v.name || (chat && (chat.name || chat.formattedTitle)) || v.id;
    if (v.canPost && v.state !== 'terminated') {
      channels.push({ id: v.id, name, role: v.role, isChannel: true });
    } else {
      // A failed check is never treated as eligible.
      degraded = degraded || Boolean(v.error);
      ineligible.push({ id: v.id, name, role: v.role, state: v.state, error: v.error || null });
    }
  }
  return { channels, checked: verdicts.length, ineligible, degraded };
}

// Lists newsletters the account can post to.
// Returns { channels, checked, ineligible, degraded }.
async function listPostableChannels(client) {
  const all = await client.getChannels();
  const ids = all
    .map((c) => c.id && (c.id._serialized || c.id.$1))
    .filter((s) => typeof s === 'string' && /@newsletter$/.test(s));
  if (ids.length === 0) return { channels: [], checked: 0, ineligible: [], degraded: false };

  const page = (await client.pupBrowser.pages())[0];
  const verdicts = await page.evaluate(pageProbe, ids);
  return partitionChannels(all, verdicts);
}

// Re-checks one channel before posting. Conservative: anything other than a
// confirmed admin/owner role refuses the post rather than risking a
// failed or unwanted publish.
async function canPostToChannel(client, channelId) {
  try {
    const page = (await client.pupBrowser.pages())[0];
    const [v] = await page.evaluate(pageProbe, [channelId]);
    return { ok: Boolean(v && v.canPost && v.state !== 'terminated'), role: v && v.role, state: v && v.state, error: v && v.error };
  } catch (e) {
    return { ok: false, role: null, state: null, error: String((e && e.message) || e).slice(0, 120) };
  }
}

module.exports = { listPostableChannels, canPostToChannel, partitionChannels, ELIGIBLE_ROLES };