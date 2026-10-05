#!/usr/bin/env node
// Генерирует черновики статей через Claude API из очереди data/topics.json.
// Каждая статья встаёт в расписание: через INTERVAL_DAYS после последней, в 09:00 МСК.
// Запуск: ANTHROPIC_API_KEY=... node scripts/generate-article.mjs [кол-во]
// В GitHub Actions результат уходит Pull Request'ом на проверку — публикуется только после мёржа.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const WEB_SEARCH_TOOL = process.env.WEB_SEARCH_TOOL ?? 'web_search_20250305'; // пустая строка — без поиска
const INTERVAL_DAYS = Number(process.env.INTERVAL_DAYS || 2);
const COUNT = Number(process.argv[2] || process.env.COUNT || 3);
const ARTICLES = path.join(ROOT, 'content/articles');
const TOPICS = path.join(ROOT, 'data/topics.json');
const USED = path.join(ROOT, 'data/topics-used.json');

if (!KEY) { console.error('Нет ANTHROPIC_API_KEY'); process.exit(1); }

const SYSTEM = `Ты — редактор блога «Грантовик» (grantovik.ru), сервиса подбора грантов и господдержки для российского бизнеса с акцентом на АПК.
Пишешь полезные статьи для Дзена и VC.ru: простой русский язык, без канцелярита и воды, конкретные шаги, примеры расчётов.

Жёсткие правила точности:
- Цифры (суммы, проценты, сроки) указывай только если нашёл их в актуальных источниках 2025–2026 гг. Если не уверен — пиши качественно, без цифр.
- Не выдумывай названия программ, документов, ведомств, кейсы клиентов и цитаты.
- Напоминай, что условия зависят от региона и их нужно сверять с региональным порядком предоставления.
- Не обещай гарантированного получения гранта.

Формат ответа — СТРОГО файл markdown с frontmatter, без пояснений до и после:
---
title: <заголовок до 90 символов, с ключевым запросом>
slug: <латиница-через-дефис>
description: <1–2 предложения, до 200 символов>
tags: <из задания>
vc_title: <альтернативный, более «журнальный» заголовок для VC.ru>
vc_lead: <лид для VC.ru, 2–3 предложения>
---
<текст 5000–8000 знаков: вступление без заголовка, затем разделы "## ...", при необходимости "### ...">

Разметка тела: только абзацы, "## ", "### ", списки "- " и "1. ", цитаты "> ", **жирный**, *курсив*, [ссылки](url). Без таблиц, без картинок, без HTML.
Ровно один раз, примерно в середине статьи, отдельной строкой поставь {{CTA}} — туда подставится блок со ссылкой на подбор грантов.
Заканчивай коротким выводом. Не упоминай, что ты ИИ.`;

async function callClaude(topic, tags, useSearch) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Тема: ${topic}\nТеги: ${tags}\nСегодня: ${new Date().toISOString().slice(0, 10)}. Сначала проверь актуальные условия, затем напиши статью.` }],
  };
  if (useSearch && WEB_SEARCH_TOOL) body.tools = [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'RU' } }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    if (useSearch && r.status === 400) { console.warn('Веб-поиск недоступен, генерирую без него:', data?.error?.message); return callClaude(topic, tags, false); }
    throw new Error(`Claude API ${r.status}: ${JSON.stringify(data)}`);
  }
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const start = text.indexOf('---');
  if (start < 0) throw new Error('Модель вернула текст без frontmatter');
  return { md: text.slice(start).trim() + '\n', searched: Boolean(body.tools) };
}

function lastDate() {
  let max = new Date();
  for (const f of fs.readdirSync(ARTICLES).filter(f => f.endsWith('.md'))) {
    const m = fs.readFileSync(path.join(ARTICLES, f), 'utf8').match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
    if (m) { const d = new Date(m[1] + 'T09:00:00+03:00'); if (d > max) max = d; }
  }
  return max;
}

const fmtDate = (d) => {
  const m = new Date(d.getTime() + 3 * 3600e3);
  return `${m.toISOString().slice(0, 10)} 09:00`;
};

async function main() {
  const topics = JSON.parse(fs.readFileSync(TOPICS, 'utf8'));
  const used = fs.existsSync(USED) ? JSON.parse(fs.readFileSync(USED, 'utf8')) : [];
  const queue = topics.filter(t => !used.includes(t.topic)).slice(0, COUNT);
  if (!queue.length) { console.log('Очередь тем пуста — добавьте темы в data/topics.json'); return; }

  let date = lastDate();
  const report = [];
  for (const t of queue) {
    date = new Date(date.getTime() + INTERVAL_DAYS * 86400e3);
    console.log(`Пишу: ${t.topic}`);
    const { md, searched } = await callClaude(t.topic, t.tags, true);
    const withDate = md.replace(/^---\n/, `---\ndate: ${fmtDate(date)}\n`);
    const slug = (withDate.match(/^slug:\s*(.+)$/m) || [])[1]?.trim() || `article-${Date.now()}`;
    const file = path.join(ARTICLES, `${fmtDate(date).slice(0, 10)}-${slug}.md`);
    if (!withDate.includes('{{CTA}}')) console.warn(`⚠ Нет {{CTA}} в ${slug}`);
    fs.writeFileSync(file, withDate);
    used.push(t.topic);
    report.push(`- ${fmtDate(date)} — ${t.topic}${searched ? '' : ' (без веб-поиска — проверить цифры особенно внимательно)'}`);
  }
  fs.writeFileSync(USED, JSON.stringify(used, null, 2) + '\n');
  fs.mkdirSync(path.join(ROOT, '.autopost'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.autopost/generated.md'), report.join('\n') + '\n');
  console.log(report.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
