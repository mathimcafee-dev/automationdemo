// /api/analyze?domain=partner.com
// Server-side brand extractor for the Partner Demo Factory.
// Fetches the partner's homepage (+ contact/about pages when needed) and returns
// company name, logo candidates, contact email, phone, theme colour and socials.

const UA = 'Mozilla/5.0 (compatible; DemoFactoryBot/1.0; +https://ssldemo.site)';
const TIMEOUT = 7000;

function norm(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}
async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: ctl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/html|xml|text/.test(ct)) return null;
    const html = await r.text();
    return { url: r.url, html: html.slice(0, 1_500_000) };
  } catch (e) { return null; } finally { clearTimeout(t); }
}
function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
}
function attrs(tag) {
  const o = {}; const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g; let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
  return o;
}
function tags(html, name) {
  const out = []; const re = new RegExp(`<${name}\\b[^>]*>`, 'gi'); let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], a: attrs(m[0]), i: m.index });
  return out;
}
function abs(u, base) { try { if (!u || /^(data|javascript|mailto|tel):/i.test(u)) return null; return new URL(u, base).href; } catch (e) { return null; } }
function text(html) { return decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')); }
function meta(html, key) {
  const t = tags(html, 'meta').find(x => (x.a.property || x.a.name || '').toLowerCase() === key);
  return t ? t.a.content : null;
}

// ---------- extractors ----------
function cleanName(n, dom) {
  if (!n) return null; n = decode(n).replace(/^@/, '').replace(/https?:\/\/\S*/gi, ' ').trim();
  n = n.split(/[|·•–—]/)[0].split(/\s[-:]\s/)[0].trim().replace(/\s+(home|homepage|official site|welcome)$/i, '').trim();
  if (!n || n.length < 2 || /^https?$/i.test(n) || /^www\./i.test(n)) return null;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(n)) { const b = n.replace(/^www\./i, '').split('.')[0]; return b.charAt(0).toUpperCase() + b.slice(1); }
  return n.slice(0, 48);
}
function extractName(html, dom) {
  const cands = [meta(html, 'og:site_name'), meta(html, 'application-name'), meta(html, 'twitter:site')];
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); if (t) cands.push(t[1]);
  for (const c of cands) { const n = cleanName(c, dom); if (n) return n; }
  const b = dom.split('.')[0]; return b.charAt(0).toUpperCase() + b.slice(1);
}
function extractJsonLd(html) {
  const out = { name: null, logo: null, email: null, phone: null, socials: [] };
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        const t = String(o['@type'] || '').toLowerCase();
        if (/organization|localbusiness|corporation|store|company|website/.test(t)) {
          if (!out.name && typeof o.name === 'string') out.name = o.name;
          const lg = typeof o.logo === 'string' ? o.logo : o.logo && o.logo.url; if (!out.logo && lg) out.logo = lg;
          if (!out.email && o.email) out.email = String(o.email).replace(/^mailto:/i, '');
          if (!out.phone && o.telephone) out.phone = String(o.telephone);
          if (Array.isArray(o.sameAs)) out.socials.push(...o.sameAs);
        }
        if (o.contactPoint) walk(o.contactPoint);
        if (t === 'contactpoint') { if (!out.email && o.email) out.email = o.email; if (!out.phone && o.telephone) out.phone = o.telephone; }
        Object.values(o).forEach(v => { if (v && typeof v === 'object') walk(v); });
      };
      walk(JSON.parse(m[1]));
    } catch (e) { /* ignore bad json-ld */ }
  }
  return out;
}
function extractLogos(html, base, dom) {
  const c = []; // {url, score, why}
  const push = (u, score, why) => { const a = abs(u, base); if (a && !/\.(mp4|webm|pdf)(\?|$)/i.test(a)) c.push({ url: a, score, why }); };
  const ld = extractJsonLd(html); if (ld.logo) push(ld.logo, 100, 'json-ld logo');
  // <img> with logo hints, header/nav context boosted
  const headerEnd = (() => { const m = /<\/header>|<\/nav>/i.exec(html); return m ? m.index : Math.min(html.length, 60000); })();
  tags(html, 'img').forEach(t => {
    const s = `${t.a.src || ''} ${t.a['data-src'] || ''} ${t.a.class || ''} ${t.a.id || ''} ${t.a.alt || ''} ${t.a.title || ''}`.toLowerCase();
    const src = t.a.src && !/^data:/.test(t.a.src) ? t.a.src : (t.a['data-src'] || t.a['data-lazy-src'] || (t.a.srcset || '').split(',')[0].trim().split(' ')[0]);
    if (!src) return;
    let score = 0;
    if (/logo/.test(s)) score = 80; else if (/brand|site-title|navbar-brand/.test(s)) score = 60; else if (new RegExp(dom.split('.')[0], 'i').test(s)) score = 50;
    if (!score) return;
    if (t.i < headerEnd) score += 10;
    if (/icon|favicon/.test(s)) score -= 20;
    push(src, score, 'img logo');
  });
  // svg-in-anchor logos can't be fetched as image; skip. og:logo / apple icons / favicon
  const og = meta(html, 'og:logo'); if (og) push(og, 70, 'og:logo');
  tags(html, 'link').forEach(t => {
    const rel = (t.a.rel || '').toLowerCase(); if (!t.a.href) return;
    if (/apple-touch-icon/.test(rel)) { const sz = parseInt((t.a.sizes || '0').split('x')[0], 10) || 0; push(t.a.href, 55 + Math.min(sz, 512) / 100, 'apple-touch-icon'); }
    else if (/\bicon\b/.test(rel)) { const sz = parseInt((t.a.sizes || '0').split('x')[0], 10) || 0; push(t.a.href, 30 + Math.min(sz, 256) / 100, 'favicon'); }
  });
  const ogi = meta(html, 'og:image'); if (ogi) push(ogi, 35, 'og:image');
  push(`https://logo.clearbit.com/${dom}`, 25, 'clearbit');
  push(`https://www.google.com/s2/favicons?domain=${dom}&sz=128`, 10, 'google favicon');
  // de-dupe keep best score
  const seen = new Map(); c.forEach(x => { const k = x.url.split('?')[0]; if (!seen.has(k) || seen.get(k).score < x.score) seen.set(k, x); });
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
function extractEmails(html, dom) {
  const found = new Map(); // email -> score
  const add = (e, s) => { e = String(e).toLowerCase().replace(/^mailto:/, '').split('?')[0].trim(); if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return; if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e) || /(sentry|wixpress|example\.|domain\.com|email\.com|yourdomain|sample)/.test(e)) return; found.set(e, Math.max(found.get(e) || 0, s)); };
  tags(html, 'a').forEach(t => { if (/^mailto:/i.test(t.a.href || '')) add(t.a.href, 60); });
  (text(html).match(EMAIL_RE) || []).forEach(e => add(e, 30));
  (html.match(EMAIL_RE) || []).forEach(e => add(e, 15));
  const root = dom.replace(/^www\./, '');
  const rank = (e) => { let s = found.get(e); if (e.endsWith('@' + root) || e.endsWith('.' + root)) s += 40; if (/^(support|help|info|sales|contact|hello|care|service)@/.test(e)) s += 25; if (/^(no-?reply|donotreply|privacy|abuse|dmca|legal|billing|jobs|career|press)@/.test(e)) s -= 30; if (/@(gmail|yahoo|hotmail|outlook)\./.test(e)) s -= 15; return s; };
  return [...found.keys()].map(e => ({ email: e, score: rank(e) })).sort((a, b) => b.score - a.score);
}
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
function cleanPhone(p) { p = String(p).replace(/^[^\d+]+|[^\d)]+$/g, ''); const d = p.replace(/[^\d+]/g, ''); if (d.replace(/\D/g, '').length < 8 || d.replace(/\D/g, '').length > 15) return null; return p.replace(/\s+/g, ' ').trim(); }
function extractPhones(html) {
  const found = new Map();
  const add = (p, s) => { const c = cleanPhone(String(p).replace(/^tel:/i, '')); if (!c) return; const k = c.replace(/[^\d+]/g, ''); if (/^(19|20)\d{6}$/.test(k)) return; found.set(k, { phone: c, score: Math.max((found.get(k) || {}).score || 0, s) }); };
  tags(html, 'a').forEach(t => { if (/^tel:/i.test(t.a.href || '')) add(t.a.href, 70); });
  const tx = text(html);
  const ctxRe = /(?:phone|call|tel|telephone|hotline|whatsapp|mobile|contact)[^\d+]{0,25}(\+?\d[\d\s().-]{7,}\d)/gi; let m;
  while ((m = ctxRe.exec(tx))) add(m[1], 50);
  (tx.match(PHONE_RE) || []).forEach(p => { if (/^\+/.test(p.trim()) || /\(\d{2,4}\)/.test(p)) add(p, 30); });
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}
function extractSocials(html) {
  const s = {}; tags(html, 'a').forEach(t => { const h = t.a.href || ''; const m = /https?:\/\/(?:www\.)?(facebook|twitter|x|linkedin|instagram|youtube)\.com\/[^\s"'#?]+/i.exec(h); if (m && !s[m[1].toLowerCase()]) s[m[1].toLowerCase() === 'x' ? 'twitter' : m[1].toLowerCase()] = m[0]; });
  return s;
}
function contactLinks(html, base) {
  const out = new Set();
  tags(html, 'a').forEach(t => { const h = t.a.href || ''; if (/contact|about|support|reach-us|get-in-touch/i.test(h) && !/^(mailto|tel|javascript):/i.test(h)) { const a = abs(h, base); if (a && new URL(a).host.replace(/^www\./, '') === new URL(base).host.replace(/^www\./, '')) out.add(a.split('#')[0]); } });
  return [...out].slice(0, 3);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const dom = norm(req.query.domain);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return res.status(400).json({ error: 'Enter a domain like partner.com' });
  const t0 = Date.now(); const pages = [];
  let home = await get('https://' + dom) || await get('https://www.' + dom) || await get('http://' + dom);
  if (!home) return res.status(200).json({ ok: false, domain: dom, error: 'Site unreachable', ms: Date.now() - t0 });
  pages.push(home.url);
  const ld = extractJsonLd(home.html);
  const out = {
    ok: true, domain: dom, finalUrl: home.url,
    name: cleanName(ld.name, dom) || extractName(home.html, dom),
    description: (meta(home.html, 'description') || meta(home.html, 'og:description') || '').slice(0, 200) || null,
    theme: (() => { const t = meta(home.html, 'theme-color'); return t && /^#([0-9a-f]{3}){1,2}$/i.test(t) ? t : null; })(),
    logos: extractLogos(home.html, home.url, dom),
    emails: extractEmails(home.html, dom),
    phones: extractPhones(home.html),
    socials: extractSocials(home.html),
  };
  if (ld.email) out.emails.unshift({ email: ld.email.toLowerCase(), score: 120 });
  if (ld.phone) out.phones.unshift({ phone: ld.phone, score: 120 });
  // Need more? crawl contact/about pages (max 3, in parallel)
  if (!out.emails.length || !out.phones.length) {
    let links = contactLinks(home.html, home.url);
    if (!links.length) links = ['/contact', '/contact-us', '/about'].map(p => new URL(p, home.url).href);
    const extra = (await Promise.all(links.map(get))).filter(Boolean);
    extra.forEach(p => { pages.push(p.url); const l2 = extractJsonLd(p.html); if (l2.email) out.emails.push({ email: l2.email.toLowerCase(), score: 110 }); if (l2.phone) out.phones.push({ phone: l2.phone, score: 110 }); out.emails.push(...extractEmails(p.html, dom)); out.phones.push(...extractPhones(p.html)); if (!out.logos.length) out.logos = extractLogos(p.html, p.url, dom); });
    const de = new Map(); out.emails.forEach(e => { if (!de.has(e.email) || de.get(e.email).score < e.score) de.set(e.email, e); }); out.emails = [...de.values()].sort((a, b) => b.score - a.score);
    const dp = new Map(); out.phones.forEach(p => { const k = p.phone.replace(/[^\d+]/g, ''); if (!dp.has(k) || dp.get(k).score < p.score) dp.set(k, p); }); out.phones = [...dp.values()].sort((a, b) => b.score - a.score);
  }
  out.emails = out.emails.slice(0, 6); out.phones = out.phones.slice(0, 4);
  out.email = out.emails[0] ? out.emails[0].email : null;
  out.phone = out.phones[0] ? out.phones[0].phone : null;
  out.logo = out.logos[0] ? out.logos[0].url : null;
  out.pages = pages; out.ms = Date.now() - t0;
  return res.status(200).json(out);
}
