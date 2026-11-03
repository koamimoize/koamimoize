import { readFile, writeFile } from 'node:fs/promises';

const FEED_URL = 'https://koami.substack.com/feed';
const OUTPUT = 'src/data/substack-posts.json';

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function tag(xml, name) {
  const escaped = name.replace(':', '\\:');
  const match = xml.match(new RegExp('<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + escaped + '>'));
  return match ? decodeXml(match[1]).trim() : '';
}
function canonicalUrl(value = '') {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}
function slugFrom(url, title) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && last !== 'p') return last.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  } catch {}
  return title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function hasBody(html = '') {
  return Boolean(html && html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
}

const response = await fetch(FEED_URL, { headers: { 'User-Agent': 'KoamiPersonalSite/1.0' } });
if (!response.ok) throw new Error('Substack RSS returned HTTP ' + response.status);
const xml = await response.text();
const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, item]) => {
  const title = tag(item, 'title');
  const url = canonicalUrl(tag(item, 'link'));
  const content = tag(item, 'content:encoded') || tag(item, 'description');
  const description = tag(item, 'description').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const rawDate = tag(item, 'pubDate');
  const date = rawDate ? new Date(rawDate).toISOString() : '';
  return {
    id: url,
    slug: slugFrom(url, title),
    title,
    url,
    publishedAt: date,
    description: description.slice(0, 320),
    contentHtml: content,
    contentAvailable: hasBody(content),
    source: 'substack-rss'
  };
}).filter(post => post.title && post.url);

if (!items.length) throw new Error('No posts found in the Substack RSS feed; keeping the existing archive unchanged.');

let existing = [];
try { existing = JSON.parse(await readFile(OUTPUT, 'utf8')); } catch {}
// Merge by canonical publication URL, not by the export's internal ID.
// This prevents an exported post and its RSS version from appearing twice.
const byUrl = new Map();
for (const post of existing) {
  const key = canonicalUrl(post.url || post.id);
  if (!key) continue;
  byUrl.set(key, { ...post, id: key, url: key });
}
for (const post of items) {
  const key = canonicalUrl(post.url);
  const previous = byUrl.get(key);
  byUrl.set(key, previous ? {
    ...previous,
    ...post,
    description: post.description || previous.description || '',
    contentHtml: hasBody(post.contentHtml) ? post.contentHtml : (previous.contentHtml || ''),
    contentAvailable: hasBody(post.contentHtml) || Boolean(previous.contentAvailable)
  } : post);
}
const merged = [...byUrl.values()].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
await writeFile(OUTPUT, JSON.stringify(merged, null, 2) + '\n');
console.log('Imported ' + items.length + ' published RSS posts; archive now contains ' + merged.length + ' unique published posts.');
