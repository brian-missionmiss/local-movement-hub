// Admin-only publishing of an approved story to the Mission Mississippi Facebook Page and Instagram account.
// The Meta token lives only in Vercel environment variables. Every call is checked against Supabase:
// the caller must be a signed-in, active admin, and the story must be approved AND approved for social.
//
// Environment variables (Vercel project settings):
//   META_PAGE_ID        Facebook Page ID
//   META_PAGE_TOKEN     long-lived Page access token
//   META_IG_USER_ID     Instagram professional account ID linked to the Page
//   META_GRAPH_VERSION  optional, default v23.0
//   SITE_ORIGIN         optional, default https://hub.missionmississippi.org

const SB_URL = 'https://rjscdzpriwhgcukynnto.supabase.co';
const SB_KEY = 'sb_publishable_sFV0SWRaHsfY2bAD1fqgig_rdp7B1qU';
const IMG_PREFIX = SB_URL + '/storage/v1/object/public/social-images/';
const MAX_CAPTION = 2200;

function cfg() {
  const v = process.env.META_GRAPH_VERSION || 'v23.0';
  return {
    graph: 'https://graph.facebook.com/' + v,
    page: process.env.META_PAGE_ID, pageToken: process.env.META_PAGE_TOKEN, ig: process.env.META_IG_USER_ID,
    origin: process.env.SITE_ORIGIN || 'https://hub.missionmississippi.org',
  };
}
const configured = c => ({ facebook: !!(c.page && c.pageToken), instagram: !!(c.ig && c.pageToken) });

async function sb(path, token, opts = {}) {
  const r = await fetch(SB_URL + path, { ...opts, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
  return { ok: r.ok, status: r.status, json: j };
}

async function requireAdmin(token) {
  if (!token) return null;
  const u = await sb('/auth/v1/user', token);
  if (!u.ok || !u.json || !u.json.id) return null;
  const p = await sb('/rest/v1/lm_profiles?id=eq.' + encodeURIComponent(u.json.id) + '&select=role,active', token);
  const row = p.ok && Array.isArray(p.json) ? p.json[0] : null;
  if (!row || row.role !== 'admin' || row.active === false) return null;
  return u.json.id;
}

async function graph(c, path, params) {
  const body = new URLSearchParams({ ...params, access_token: c.pageToken });
  const r = await fetch(c.graph + path, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('Meta returned ' + r.status));
  return j;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postInstagram(c, imageUrl, caption) {
  const cont = await graph(c, '/' + c.ig + '/media', { image_url: imageUrl, caption });
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { const pub = await graph(c, '/' + c.ig + '/media_publish', { creation_id: cont.id }); return pub.id; }
    catch (e) { lastErr = e; await sleep(i === 0 ? 1500 : 3000); }
  }
  throw lastErr;
}

function allowedImage(c, url) {
  return typeof url === 'string' && (url.startsWith(IMG_PREFIX) || url === c.origin + '/assets/mm-logo-social.jpg');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = await requireAdmin(token);
  if (!uid) return res.status(403).json({ error: 'Admins only.' });

  const c = cfg();
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (b.action === 'status') return res.status(200).json({ configured: configured(c), logo: c.origin + '/assets/mm-logo-social.jpg' });
  if (b.action !== 'publish') return res.status(400).json({ error: 'Unknown action.' });

  const caption = String(b.caption || '').trim();
  const platforms = (Array.isArray(b.platforms) ? b.platforms : []).filter(p => p === 'facebook' || p === 'instagram');
  if (!caption) return res.status(400).json({ error: 'Write a caption first.' });
  if (caption.length > MAX_CAPTION) return res.status(400).json({ error: 'Caption is over ' + MAX_CAPTION + ' characters.' });
  if (!platforms.length) return res.status(400).json({ error: 'Choose at least one platform.' });
  if (!allowedImage(c, b.image_url)) return res.status(400).json({ error: 'Image must be the Mission Mississippi logo or an uploaded image.' });

  const cf = configured(c);
  const missing = platforms.filter(p => !cf[p]);
  if (missing.length) return res.status(503).json({ error: 'Not connected yet: ' + missing.join(', ') + '. Add the Meta credentials in Vercel first.' });

  const sid = String(b.story_id || '');
  const st = await sb('/rest/v1/lm_stories?id=eq.' + encodeURIComponent(sid) + '&select=id,approved,social_approved', token);
  const story = st.ok && Array.isArray(st.json) ? st.json[0] : null;
  if (!story) return res.status(404).json({ error: 'Story not found.' });
  if (!story.approved || !story.social_approved) return res.status(409).json({ error: 'This story is not approved for social.' });

  const prior = await sb('/rest/v1/lm_social_posts?story_id=eq.' + encodeURIComponent(sid) + '&status=eq.posted&select=platform', token);
  const done = new Set((prior.json || []).map(r => r.platform));
  const results = {};
  for (const p of platforms) {
    if (done.has(p)) { results[p] = { ok: false, error: 'Already posted to ' + p + '.' }; continue; }
    try {
      const id = p === 'facebook'
        ? await (async () => { const r = await graph(c, '/' + c.page + '/photos', { url: b.image_url, caption }); return r.post_id || r.id; })()
        : await postInstagram(c, b.image_url, caption);
      results[p] = { ok: true, id };
      await sb('/rest/v1/lm_social_posts', token, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ story_id: sid, platform: p, status: 'posted', caption, image_url: b.image_url, external_id: id || null, posted_by: uid }) });
    } catch (e) {
      results[p] = { ok: false, error: e.message };
      await sb('/rest/v1/lm_social_posts', token, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ story_id: sid, platform: p, status: 'failed', caption, image_url: b.image_url, error: String(e.message).slice(0, 500), posted_by: uid }) });
    }
  }
  return res.status(200).json({ results });
};
module.exports._test = { allowedImage, configured };
