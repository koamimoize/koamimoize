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
  const match = xml.match(new RegExp('<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escaped + '>'));
  return match ? decodeXml(match[1]).trim() : '';
}
function slugFrom(url, title) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && last !== 'p') return last.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  } catch {}
  return title.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const response = await fetch(FEED_URL, { headers: { 'User-Agent': 'KoamiPersonalSite/1.0' } });
if (!response.ok) throw new Error(`Substack RSS returned HTTP ${response.status}`);
const xml = await response.text();
const items = [...xml.matchAll(/<item(?:\\s[^>]*)?>([\\s\\S]*?)<\\/item>/g)].map(([, item]) => {
  const title = tag(item, 'title');
  const url = tag(item, 'link');
  const content = tag(item, 'content:encoded') || tag(item, 'description');
  const description = tag(item, 'description').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
  return {
    id: tag(item, 'guid') || url,
    slug: slugFrom(url, title),
    title,
    url,
    publishedAt: tag(item, 'pubDate'),
    description: description.slice(0, 320),
    contentHtml: content,
    syncedAt: new Date().toISOString()
  };
}).filter(post => post.title && post.url);

if (!items.length) throw new Error('No posts found in the Substack RSS feed; keeping the existing archive unchanged.');
let existing = [];
try { existing = JSON.parse(await readFile(OUTPUT, 'utf8')); } catch {}
const byId = new Map(existing.map(post => [post.id, post]));
for (const post of items) {
  const previous = byId.get(post.id);
  byId.set(post.id, previous ? { ...previous, ...post } : post);
}
const merged = [...byId.values()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
await writeFile(OUTPUT, JSON.stringify(merged, null, 2) + '\\n');
console.log(`Synced ${items.length} feed items; ${merged.length} posts in archive.`);
