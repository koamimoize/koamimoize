import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const FEED_URL = 'https://koami.substack.com/feed';
const OUTPUT = 'src/data/substack-posts.json';
const EXPORT_PARTS = [1, 2, 3, 4, 5].map((n) => 'scripts/substack-export.part-' + n + '.txt');

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

let existing = [];
try { existing = JSON.parse(await readFile(OUTPUT, 'utf8')); } catch {}
const byUrl = new Map();
function mergePost(post) {
  const key = canonicalUrl(post.url || post.id);
  if (!key) return;
  const previous = byUrl.get(key);
  const incomingHasBody = hasBody(post.contentHtml);
  const previousHasBody = hasBody(previous?.contentHtml);
  byUrl.set(key, {
    ...(previous || {}),
    ...post,
    id: key,
    url: key,
    slug: post.slug || previous?.slug || slugFrom(key, post.title || previous?.title || ''),
    description: post.description || previous?.description || '',
    contentHtml: incomingHasBody ? post.contentHtml : (previous?.contentHtml || ''),
    contentAvailable: incomingHasBody || previousHasBody || Boolean(previous?.contentAvailable)
  });
}
for (const post of existing) mergePost(post);

// Import the complete published-post export in ordered, verifiable chunks.
try {
  const chunks = await Promise.all(EXPORT_PARTS.map((path) => readFile(path, 'utf8')));
  const exportedPosts = JSON.parse(gunzipSync(Buffer.from(chunks.join('').trim(), 'base64')).toString('utf8'));
  for (const post of exportedPosts) mergePost({ ...post, source: 'substack-export' });
  console.log('Loaded ' + exportedPosts.length + ' published posts from the Substack export.');
} catch (error) {
  console.log('Substack export import failed: ' + error.message);
  throw error;
}

// Try RSS for newer posts. Substack may return 403 to hosted runners; the export remains intact.
try {
  const response = await fetch(FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoamiPersonalSite/1.0)' } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const title = tag(item, 'title');
    const url = canonicalUrl(tag(item, 'link'));
    const content = tag(item, 'content:encoded') || tag(item, 'description');
    const description = tag(item, 'description').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const rawDate = tag(item, 'pubDate');
    return {
      id: url,
      slug: slugFrom(url, title),
      title,
      url,
      publishedAt: rawDate ? new Date(rawDate).toISOString() : '',
      description: description.slice(0, 320),
      contentHtml: content,
      contentAvailable: hasBody(content),
      source: 'substack-rss'
    };
  }).filter(post => post.title && post.url);
  for (const post of items) mergePost(post);
  console.log('Imported ' + items.length + ' published RSS entries.');
} catch (error) {
  console.log('RSS unavailable (' + error.message + '); keeping the full export archive.');
}

const merged = [...byUrl.values()].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
await writeFile(OUTPUT, JSON.stringify(merged, null, 2) + '\n');
console.log('Writing archive contains ' + merged.length + ' unique published posts.');
