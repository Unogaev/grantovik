#!/usr/bin/env node
// Грантовик — сборка блога и автопостинга.
// Берёт content/articles/*.md и собирает:
//   blog/index.html, blog/<slug>/index.html, blog/sitemap.xml
//   rss/dzen.xml               — лента для Дзена (Дзен сам забирает и публикует)
//   .autopost/new.txt          — список слагов, опубликованных в этом прогоне
//   .autopost/issues/<slug>.md — готовый текст для VC.ru (уходит в GitHub Issue)
// Статья выходит, когда наступил её date (МСК) и нет draft: true.
// Без зависимостей: node scripts/build-blog.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SITE = (process.env.SITE_URL || 'https://grantovik.ru').replace(/\/$/, '');
const BRAND = 'Грантовик';
const CTA_URL = `${SITE}/`;
const DZEN_MODE = process.env.DZEN_MODE || 'publish'; // publish | draft
const FEED_SIZE = 10; // Дзен требует минимум 10 материалов при первом подключении
const NOW = process.env.BUILD_NOW ? new Date(process.env.BUILD_NOW) : new Date();

const ARTICLES_DIR = path.join(ROOT, 'content/articles');
const BLOG_DIR = path.join(ROOT, 'blog');
const RSS_DIR = path.join(ROOT, 'rss');
const STATE_FILE = path.join(ROOT, 'data/published.json');
const AUTOPOST_DIR = path.join(ROOT, '.autopost');

// ---------- утилиты ----------
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const translit = (s) => {
  const m = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return s.toLowerCase().split('').map(c => m[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
};
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const ruDate = (d) => {
  const m = new Date(d.getTime() + 3 * 3600e3); // МСК
  return `${m.getUTCDate()} ${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}`;
};
const rfc822 = (d) => {
  const m = new Date(d.getTime() + 3 * 3600e3);
  const D = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][m.getUTCDay()];
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return `${D}, ${p(m.getUTCDate())} ${M} ${m.getUTCFullYear()} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())} +0300`;
};
const withUtm = (url, source) =>
  `${url}${url.includes('?') ? '&' : '?'}utm_source=${source}&utm_medium=article&utm_campaign=autopost`;

// ---------- frontmatter ----------
function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Нет frontmatter: ${file}`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    meta[line.slice(0, i).trim()] = v;
  }
  if (!meta.title) throw new Error(`Нет title: ${file}`);
  meta.slug = meta.slug || translit(meta.title);
  meta.date = new Date((meta.date || '2000-01-01 09:00').replace(' ', 'T') + ':00+03:00');
  if (isNaN(meta.date)) throw new Error(`Кривая дата в ${file}: формат 2026-10-02 09:00`);
  meta.tags = (meta.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  meta.draft = meta.draft === 'true';
  meta.body = m[2].trim();
  meta.file = file;
  return meta;
}

// ---------- markdown → html ----------
// mode: 'site' | 'dzen'
function inline(s, mode) {
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const url = u.startsWith('/') ? SITE + u : u;
    return `<a href="${url}">${t}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  return out;
}
const stripTags = (s) => s.replace(/<[^>]+>/g, '');

function mdToHtml(md, mode, ctaHtml) {
  const lines = md.split('\n');
  const html = [];
  const toc = [];
  let para = [];
  let list = null; // {type, items}
  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(' '), mode)}</p>`); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(it => {
      const c = inline(it, mode);
      return `<li>${mode === 'dzen' ? stripTags(c) : c}</li>`; // Дзен не поддерживает форматирование внутри списков
    }).join('');
    html.push(`<${list.type}>${items}</${list.type}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (line.trim() === '{{CTA}}') { flushPara(); flushList(); html.push(ctaHtml); continue; }
    if ((m = line.match(/^(#{2,3})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = m[1].length;
      const id = translit(m[2]);
      if (lvl === 2) toc.push({ id, text: m[2] });
      html.push(`<h${lvl} id="${id}">${inline(m[2], mode)}</h${lvl}>`);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); html.push(`<blockquote>${inline(m[1], mode)}</blockquote>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return { html: html.join('\n'), toc };
}

// md → markdown для VC (VC-редактор нормально принимает вставку из отрендеренного GitHub Issue)
function mdForVc(md) {
  return md.replace(/^\{\{CTA\}\}$/m,
    `> **Проверьте, какие гранты подходят вашему бизнесу.** Грантовик подбирает программы по ИНН за пару минут: [${SITE.replace('https://', '')}](${withUtm(CTA_URL, 'vc')})`)
    .replace(/\]\((\/[^)]*)\)/g, (_, u) => `](${SITE}${u})`);
}

// ---------- шаблоны ----------
const CSS = `
:root{--bg:#F4EFE6;--paper:#FFFCF7;--ink:#151515;--muted:#5d5850;--line:#e3dccf;--red:#D7261E}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151412;--paper:#1d1b18;--ink:#f1ece3;--muted:#a59e92;--line:#34302a}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:inherit;text-decoration-color:var(--red);text-underline-offset:3px}
.top{max-width:760px;margin:0 auto;padding:20px 16px;display:flex;justify-content:space-between;align-items:center}
.logo{font-weight:800;font-size:20px;text-decoration:none;letter-spacing:-.01em}.logo i{color:var(--red);font-style:normal}
.top nav a{font-size:15px;margin-left:18px;text-decoration:none;color:var(--muted)}
main{max-width:760px;margin:0 auto;padding:8px 16px 64px}
.kicker{font-size:14px;color:var(--muted);margin:0 0 10px}
h1{font-size:clamp(30px,5vw,44px);line-height:1.12;letter-spacing:-.02em;margin:0 0 16px}
.lead{font-size:20px;color:var(--muted);margin:0 0 28px}
.cover{width:100%;height:auto;border-radius:14px;display:block;margin:0 0 32px;aspect-ratio:16/9;object-fit:cover}
h2{font-size:27px;line-height:1.2;margin:44px 0 12px;letter-spacing:-.01em}h3{font-size:21px;margin:32px 0 8px}
blockquote{margin:24px 0;padding:4px 0 4px 18px;border-left:3px solid var(--red);color:var(--ink)}
li{margin:6px 0}
.toc{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin:0 0 32px;font-size:16px}
.toc b{display:block;margin-bottom:6px}.toc ol{margin:0;padding-left:20px}
.cta{background:var(--ink);color:var(--bg);border-radius:14px;padding:24px;margin:36px 0}
.cta p{margin:0 0 14px}.cta a.btn{display:inline-block;background:var(--red);color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px}
.note{font-size:15px;color:var(--muted);border-top:1px solid var(--line);margin-top:48px;padding-top:16px}
.list{list-style:none;padding:0;margin:24px 0 0}.list li{border-top:1px solid var(--line);padding:22px 0;margin:0}
.list a{text-decoration:none}.list h2{font-size:23px;margin:4px 0 6px}.list p{margin:0;color:var(--muted);font-size:16px}
footer{max-width:760px;margin:0 auto;padding:24px 16px 40px;font-size:14px;color:var(--muted)}
`;

const ctaSite = `<div class="cta"><p><b>Какие гранты подходят именно вам?</b><br>Грантовик подбирает программы господдержки по ИНН — с учётом региона, ОКВЭД и планов на развитие.</p><a class="btn" href="${CTA_URL}">Проверить по ИНН</a></div>`;
const ctaDzen = `<p><b>Какие гранты подходят именно вам?</b> Грантовик подбирает программы господдержки по ИНН — с учётом региона, ОКВЭД и планов на развитие: <a href="${withUtm(CTA_URL, 'dzen')}">проверить на grantovik.ru</a>.</p>`;

function layout({ title, description, canonical, body, ogImage, jsonld }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.ico">
<link rel="alternate" type="application/rss+xml" title="${BRAND} — статьи" href="${SITE}/rss/dzen.xml">
<meta property="og:type" content="article"><meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">${ogImage ? `<meta property="og:image" content="${ogImage}"><meta name="twitter:card" content="summary_large_image">` : ''}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<style>${CSS}</style>
</head>
<body>
<header class="top"><a class="logo" href="/">Грантовик<i>.</i></a><nav><a href="/blog/">Статьи</a><a href="/">Подбор грантов</a></nav></header>
<main>
${body}
</main>
<footer>© ${NOW.getFullYear()} ${BRAND} — подбор грантов и мер господдержки для бизнеса</footer>
</body>
</html>`;
}

function articlePage(a, html, toc, coverUrl) {
  const url = `${SITE}/blog/${a.slug}/`;
  const tocHtml = toc.length >= 3
    ? `<nav class="toc"><b>Содержание</b><ol>${toc.map(t => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></nav>` : '';
  const body = `<article>
<p class="kicker">${ruDate(a.date)}${a.tags.length ? ' · ' + esc(a.tags.join(', ')) : ''}</p>
<h1>${esc(a.title)}</h1>
${a.description ? `<p class="lead">${esc(a.description)}</p>` : ''}
${coverUrl ? `<img class="cover" src="/blog/covers/${a.slug}.png" alt="${esc(a.title)}" width="1200" height="675">` : ''}
${tocHtml}
${html}
<p class="note">Условия программ меняются и различаются по регионам. Перед подачей сверяйтесь с актуальным порядком на сайте регионального минсельхоза или центра «Мой бизнес».</p>
</article>`;
  return layout({
    title: `${a.title} — ${BRAND}`, description: a.description || a.title, canonical: url, body, ogImage: coverUrl,
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.description,
      datePublished: a.date.toISOString(), image: coverUrl || undefined, mainEntityOfPage: url,
      author: { '@type': 'Organization', name: BRAND }, publisher: { '@type': 'Organization', name: BRAND } },
  });
}

// ---------- сборка ----------
function main() {
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md')).map(f => path.join(ARTICLES_DIR, f));
  const all = files.map(parseFile);
  const slugs = new Set();
  for (const a of all) { if (slugs.has(a.slug)) throw new Error(`Дубль slug: ${a.slug}`); slugs.add(a.slug); }

  const live = all.filter(a => !a.draft && a.date <= NOW).sort((x, y) => y.date - x.date);
  const queued = all.filter(a => !a.draft && a.date > NOW).sort((x, y) => x.date - y.date);

  for (const a of live) {
    const coverRel = `blog/covers/${a.slug}.png`;
    a.cover = fs.existsSync(path.join(ROOT, coverRel)) ? `${SITE}/${coverRel}` : null;
    const site = mdToHtml(a.body, 'site', ctaSite);
    a.dzenHtml = mdToHtml(a.body, 'dzen', ctaDzen).html;
    write(path.join(BLOG_DIR, a.slug, 'index.html'), articlePage(a, site.html, site.toc, a.cover));
  }

  // индекс блога
  const listHtml = live.map(a => `<li><a href="/blog/${a.slug}/"><p class="kicker">${ruDate(a.date)}</p><h2>${esc(a.title)}</h2><p>${esc(a.description || '')}</p></a></li>`).join('\n');
  write(path.join(BLOG_DIR, 'index.html'), layout({
    title: `Статьи о грантах и господдержке — ${BRAND}`,
    description: 'Разборы грантов, субсидий и мер господдержки для малого бизнеса и фермеров: условия, суммы, документы, типичные ошибки.',
    canonical: `${SITE}/blog/`,
    body: `<h1>Гранты и господдержка: разборы</h1><p class="lead">Простыми словами о том, как бизнесу и фермерам получить деньги от государства и не ошибиться в заявке.</p><ul class="list">${listHtml}</ul>`,
  }));

  // sitemap блога
  write(path.join(BLOG_DIR, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/blog/</loc></url>
${live.map(a => `<url><loc>${SITE}/blog/${a.slug}/</loc><lastmod>${a.date.toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`);

  // RSS для Дзена
  const cats = [DZEN_MODE === 'draft' ? 'native-draft' : null, 'format-article', 'index', 'comment-all'].filter(Boolean);
  const items = live.slice(0, FEED_SIZE).map(a => {
    const body = (a.cover ? `<figure><img src="${a.cover}"><figcaption>${esc(a.title)}</figcaption></figure>\n` : '') + a.dzenHtml;
    return `<item>
<title>${esc(a.title)}</title>
<link>${SITE}/blog/${a.slug}/</link>
<guid>${SITE}/blog/${a.slug}/</guid>
<pubDate>${rfc822(a.date)}</pubDate>
<media:rating scheme="urn:simple">nonadult</media:rating>
${cats.map(c => `<category>${c}</category>`).join('\n')}
${a.description ? `<description>${esc(a.description)}</description>` : ''}
${a.cover ? `<enclosure url="${a.cover}" type="image/png"/>` : ''}
<content:encoded><![CDATA[${body.replace(/]]>/g, ']]]]><![CDATA[>')}]]></content:encoded>
</item>`;
  }).join('\n');
  write(path.join(RSS_DIR, 'dzen.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">
<channel>
<title>${BRAND}</title>
<link>${SITE}/</link>
<description>Гранты и господдержка для бизнеса и фермеров</description>
<language>ru</language>
<atom:link href="${SITE}/rss/dzen.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>
`);

  // новые публикации → задачи на ручной/полуавтоматический кросспостинг (VC)
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { published: [] };
  const known = new Set(state.published);
  const fresh = live.filter(a => !known.has(a.slug)).reverse();
  fs.rmSync(AUTOPOST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(AUTOPOST_DIR, 'issues'), { recursive: true });
  for (const a of fresh) {
    const vcTitle = a.vc_title || a.title;
    const issue = `**Опубликовать на VC.ru** (раздел «Финансы» или «Малый бизнес»)

- [ ] Открыть https://vc.ru → «Написать»
- [ ] Заголовок: скопировать из блока ниже
- [ ] Обложка: ${a.cover || '—'}
- [ ] Вставить текст (выделить отрендеренный текст ниже → Ctrl+C → Ctrl+V в редактор VC)
- [ ] Ссылку на опубликованный пост добавить комментарием и закрыть задачу

Оригинал на сайте: ${SITE}/blog/${a.slug}/
В Дзен статья уходит автоматически через RSS.

---

# ${vcTitle}

${a.vc_lead ? `**${a.vc_lead}**\n\n` : ''}${mdForVc(a.body)}
`;
    write(path.join(AUTOPOST_DIR, 'issues', `${a.slug}.md`), issue);
    write(path.join(AUTOPOST_DIR, 'issues', `${a.slug}.title`), `VC.ru: ${vcTitle}`);
    state.published.push(a.slug);
  }
  write(path.join(AUTOPOST_DIR, 'new.txt'), fresh.map(a => a.slug).join('\n'));
  write(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

  console.log(`Опубликовано: ${live.length}, в очереди: ${queued.length}, новых в этом прогоне: ${fresh.length}`);
  if (queued[0]) console.log(`Следующая: «${queued[0].title}» — ${ruDate(queued[0].date)}`);
  if (live.length < FEED_SIZE) console.log(`⚠ Для подключения RSS к Дзену нужно минимум ${FEED_SIZE} опубликованных статей, сейчас ${live.length}`);
}

main();
