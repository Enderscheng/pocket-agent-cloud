// Discord screens for the calendar, opened with /calendar or from /panel:
// 📅 settings: each category's title icon and default reminders (a form per category);
// 🗓️ upcoming: pick an item to change its title and reminders, also in Google Calendar.
// Owner checks and signature checks happen in discord.js before anything here runs.
import {
  CATEGORIES, calendarName, categorySettings, saveCategorySettings, resetCategorySettings, cleanIcon, upcomingTasks,
  getTask, editTask, syncQuietly, taskReminders, parseReminders, formatReminders, describeReminders, describeDue, TaskError,
} from './tasks.js';
import { editOriginal } from './discord.js';

const SETTINGS_TITLE = '📅 日曆設定';
const UPCOMING_TITLE = '🗓️ 未來 14 日嘅活動';
const UPCOMING_DAYS = 14;
const reply = (type, data) => Response.json({ type, ...(data ? { data } : {}) });
const UPDATE = 7, NEW_MESSAGE = 4, MODAL = 9, DEFERRED_UPDATE = 6;

export async function settingsMessage(env, note = '') {
  const lines = [];
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const s = await categorySettings(env, key);
    lines.push(`${cat.emoji} **${calendarName(key)}**　標題 icon：${s.icon || '（冇）'}`,
      `-# 有時間嘅活動：${describeReminders(s.timed, false, true)}　·　全日活動：${describeReminders(s.allday, true, true)}`);
  }
  return {
    flags: 64, content: note, allowed_mentions: { parse: [] },
    embeds: [{ title: SETTINGS_TITLE, color: 0x174ab9, description: lines.join('\n'),
      footer: { text: '喺下面揀分類就可以改。新設定用喺之後新加嘅活動；已經加咗嘅，用「改即將活動」逐個改。' } }],
    components: [
      { type: 1, components: [{ type: 3, custom_id: 'cal:pick', placeholder: '揀一個分類嚟改 icon 同提醒',
        options: Object.entries(CATEGORIES).map(([key, cat]) => ({ label: calendarName(key), value: key, emoji: { name: cat.emoji }, description: '改標題 icon 同預設提醒' })) }] },
      { type: 1, components: [
        { type: 2, style: 1, custom_id: 'cal:upcoming', label: '改即將活動', emoji: { name: '🗓️' } },
        { type: 2, style: 4, custom_id: 'cal:reset', label: '全部還原預設' },
      ] },
    ],
  };
}

export async function upcomingMessage(env, note = '') {
  const tasks = await upcomingTasks(env, UPCOMING_DAYS);
  const icon = t => CATEGORIES[t.category]?.emoji || '•';
  const lines = tasks.map(t => `${icon(t)} **${t.title}** — ${describeDue(t, true)}\n-# 提醒：${describeReminders(taskReminders(t), !t.due_time, true)}${t.event_id ? '' : ' · ⚠️ 未加入日曆'}`);
  const components = [];
  if (tasks.length) components.push({ type: 1, components: [{ type: 3, custom_id: 'cal:item', placeholder: '揀一項嚟改名或者改提醒',
    options: tasks.slice(0, 25).map(t => ({ label: t.title.slice(0, 100), value: String(t.id), emoji: { name: icon(t) === '•' ? '📌' : icon(t) },
      description: describeDue(t, true).slice(0, 100) })) }] });
  components.push({ type: 1, components: [{ type: 2, style: 2, custom_id: 'cal:settings', label: '返去日曆設定', emoji: { name: '📅' } }] });
  return {
    flags: 64, content: note, allowed_mentions: { parse: [] },
    embeds: [{ title: UPCOMING_TITLE, color: 0x174ab9, description: (lines.join('\n') || '未來 14 日冇活動 🎉').slice(0, 4000),
      footer: { text: '只包括 Pocket Agent 加嘅活動。要取消，撳返嗰項 Discord 卡下面嘅「取消」。' } }],
    components,
  };
}

const textInput = (id, label, value, placeholder, { required = false, max = 100 } = {}) => ({ type: 1, components: [{
  type: 4, custom_id: id, style: 1, label, placeholder, required, max_length: max, ...(value ? { value } : {}) }] });

async function categoryForm(env, key) {
  const s = await categorySettings(env, key);
  return { custom_id: `cal:save:${key}`, title: `${calendarName(key)} 設定`.slice(0, 45), components: [
    textInput('icon', '標題前面嘅 icon（可以留空）', s.icon, '例如 🎂 或者 📚', { max: 16 }),
    textInput('timed', '有時間嘅活動：幾耐之前提醒', formatReminders(s.timed, false), '例如：1日, 2個鐘, 30分鐘（留空 = 唔提醒）'),
    textInput('allday', '全日活動：前幾日、幾點提醒', formatReminders(s.allday, true), '例如：1日 09:00, 7日 20:00（留空 = 唔提醒）'),
  ] };
}
function itemForm(task) {
  const allDay = !task.due_time;
  return { custom_id: `cal:edit:${task.id}`, title: '改活動'.slice(0, 45), components: [
    textInput('title', '名稱', task.title, '', { required: true, max: 80 }),
    textInput('reminders', allDay ? '提醒：前幾日、幾點（全日活動）' : '提醒：幾耐之前（有時間嘅活動）', formatReminders(taskReminders(task), allDay),
      allDay ? '例如：1日 09:00, 7日 20:00（留空 = 唔提醒）' : '例如：1日, 2個鐘, 30分鐘（留空 = 唔提醒）'),
  ] };
}
function formValues(data) {
  const out = {};
  for (const row of data?.components || []) for (const c of row.components || (row.component ? [row.component] : [])) out[c.custom_id] = String(c.value ?? '');
  return out;
}
const problem = error => `⚠️ ${error instanceof TaskError ? error.message : '出咗少少問題，請再試一次。'}`;

// Our own screens are edited in place; from /panel a new private message opens instead.
const ours = interaction => (interaction.message?.embeds || []).some(e => e.title === SETTINGS_TITLE || e.title === UPCOMING_TITLE);

export async function calendarInteraction(env, ctx, interaction) {
  const id = interaction.data?.custom_id || '';
  const show = async (build, note) => reply(ours(interaction) ? UPDATE : NEW_MESSAGE, await build(env, note));
  try {
    if (id === 'cal:settings') return show(settingsMessage);
    if (id === 'cal:upcoming') {
      // Checking Google for items deleted by hand takes a moment: acknowledge, then show the list.
      const inPlace = ours(interaction);
      ctx.waitUntil((async () => {
        const removed = await syncQuietly(env, UPCOMING_DAYS);
        const note = removed ? `🧹 有 ${removed} 項已經喺日曆刪咗，已經由列表移走。` : '';
        await editOriginal(env, interaction.token, await upcomingMessage(env, note).catch(error => ({ content: problem(error) })));
      })());
      return inPlace ? reply(DEFERRED_UPDATE) : reply(5, { flags: 64 });
    }
    if (id === 'cal:reset') { await resetCategorySettings(env); return show(settingsMessage, '✅ 全部分類已經還原預設。'); }
    if (id === 'cal:pick') {
      const key = String(interaction.data.values?.[0] || '');
      if (!CATEGORIES[key]) return show(settingsMessage, '⚠️ 冇呢個分類。');
      return reply(MODAL, await categoryForm(env, key));
    }
    if (id === 'cal:item') {
      const task = await getTask(env, Number(interaction.data.values?.[0]));
      if (!task || task.status !== 'active') return show(upcomingMessage, '⚠️ 呢項已經取消咗。');
      return reply(MODAL, itemForm(task));
    }
    let match = /^cal:save:(\w+)$/.exec(id);
    if (match && CATEGORIES[match[1]]) {
      const values = formValues(interaction.data);
      const settings = { icon: cleanIcon(values.icon), timed: parseReminders(values.timed, false), allday: parseReminders(values.allday, true) };
      await saveCategorySettings(env, match[1], settings);
      return show(settingsMessage, `✅ 已經改好 ${calendarName(match[1])}。之後新加嘅活動會用新設定。`);
    }
    match = /^cal:edit:(\d{1,12})$/.exec(id);
    if (match) {
      const task = await getTask(env, Number(match[1]));
      if (!task || task.status !== 'active') return show(upcomingMessage, '⚠️ 呢項已經取消咗。');
      const values = formValues(interaction.data);
      const reminders = parseReminders(values.reminders, !task.due_time);
      // Google can take a few seconds: acknowledge now, then refresh the list.
      ctx.waitUntil((async () => {
        let note;
        try { const edited = await editTask(env, task.id, { title: values.title, reminders }); note = `✅ 已經改好「${edited.title}」，日曆都更新咗。`; }
        catch (error) { note = problem(error); }
        await editOriginal(env, interaction.token, await upcomingMessage(env, note).catch(() => ({ content: note })));
      })());
      return reply(DEFERRED_UPDATE);
    }
    return reply(NEW_MESSAGE, { flags: 64, content: '呢個掣已經過期，請再開 /calendar。' });
  } catch (error) {
    const build = id.startsWith('cal:edit') || id === 'cal:item' || id === 'cal:upcoming' ? upcomingMessage : settingsMessage;
    try { return await show(build, problem(error)); } catch { return reply(NEW_MESSAGE, { flags: 64, content: problem(error) }); }
  }
}
