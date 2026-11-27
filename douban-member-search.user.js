// ==UserScript==
// @name         豆瓣小组成员名单搜索
// @namespace    local.douban.member-list-search
// @version      1.1.0
// @description  按 ID、主页链接或昵称查找豆瓣小组成员，支持断点续读和 CSV 导出。
// @match        https://www.douban.com/group/*/members*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const groupPath = location.pathname.match(/^\/group\/[^/]+\/members\/?$/)?.[0];
  if (!groupPath) return;
  const path = groupPath.replace(/\/$/, '');
  const key = 'member-roster-v1:' + path;
  const pageSize = 36;
  const firstUrl = new URL(path + '?start=0', location.origin);
  const normalize = text => text.normalize('NFC').trim().toLowerCase();
  const pageNumber = offset => offset / pageSize + 1;
  const dateLabel = timestamp => new Date(timestamp).toLocaleString();

  function profileKey(url) {
    if (url.origin !== location.origin) return '';
    const segment = url.pathname.match(/^\/people\/([^/]+)\/?$/)?.[1];
    return segment ? decodeURIComponent(segment) : '';
  }

  function offsetOf(url) {
    if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== path) return null;
    if ([...url.searchParams.keys()].some(name => name !== 'start')) return null;
    const raw = url.searchParams.get('start') ?? '0';
    if (!/^\d+$/.test(raw)) return null;
    const offset = Number(raw);
    return Number.isSafeInteger(offset) && offset % pageSize === 0 ? offset : null;
  }

  function readPage(doc, url, offset, lastKnownOffset) {
    const content = doc.querySelector('#content');
    if (!content) throw new Error('未识别到成员页正文，可能需要重新登录或打开成员页核对。');
    const members = new Map();
    const anchors = content.querySelectorAll(
      '.member-list a.nbg, .member-list .name a, .obs a.nbg, .obs .name a'
    );
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      const profile = new URL(href, url);
      const account = profileKey(profile);
      if (!account) continue;
      const image = anchor.querySelector('img');
      const avatarId = (image?.getAttribute('src') || image?.getAttribute('data-src') || '')
        .match(/\/icon\/up(\d+)(?=-|\.)/)?.[1];
      const id = /^\d+$/.test(account) ? account : avatarId || '';
      const alt = image?.getAttribute('alt')?.trim() || '';
      const name = (anchor.getAttribute('title') || anchor.textContent).trim();
      const member = members.get(account) || {
        account, id: '', nickname: '', label: '', offset,
        url: new URL(profile.pathname, location.origin).href
      };
      member.id ||= id;
      member.nickname ||= alt;
      member.label ||= name;
      members.set(account, member);
    }
    if (!members.size) throw new Error('这一页没有解析出成员，已保留进度。请打开该页核对。');

    function linkOffset(link) {
      const href = link.getAttribute('href');
      return href ? offsetOf(new URL(href, url)) : null;
    }
    const paginator = content.querySelector('.paginator');
    const nextLink = paginator?.querySelector('.next a') || doc.querySelector('link[rel="next"]');
    const visibleOffsets = [...(paginator?.querySelectorAll('a[href]') || [])]
      .map(linkOffset).filter(value => value !== null);
    const lastOffset = Math.max(offset, lastKnownOffset, ...visibleOffsets);
    const nextOffset = nextLink ? linkOffset(nextLink) : null;
    if (nextLink && nextOffset !== offset + pageSize) {
      throw new Error('下一页链接与正常分页不一致。');
    }
    if (!nextLink && lastOffset > offset && !visibleOffsets.includes(offset + pageSize)) {
      throw new Error('分页显示后面还有成员页，但没有找到紧接的下一页。');
    }
    if (!paginator && !nextLink && (offset > 0 || members.size >= pageSize)) {
      throw new Error('缺少分页信息，无法确认这里是末页。');
    }
    if (paginator && !nextLink && offset === 0 && members.size >= pageSize &&
        !paginator.querySelector('.next, .thispage') && !visibleOffsets.length) {
      throw new Error('分页区域没有可识别的页码，无法确认名单已读完。');
    }
    const next = nextOffset ?? (lastOffset > offset ? offset + pageSize : null);
    return { members: [...members.values()], lastOffset, next };
  }

  const panel = document.createElement('aside');
  panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;width:min(400px,calc(100vw - 24px));';
  const shadow = panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      details{box-sizing:border-box;background:#fff;color:#25322a;border:1px solid #bdcec1;border-radius:8px;
        box-shadow:0 4px 20px #0002;font:14px/1.5 system-ui,sans-serif;padding:10px 12px}
      summary{cursor:pointer;font-weight:650;color:#245d3c}
      form,.actions{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}
      input,select,button{font:inherit;border:1px solid #a9bcb0;border-radius:4px;padding:4px 7px;background:white;color:inherit}
      input{flex:1;min-width:0} button:enabled{cursor:pointer} button:disabled{opacity:.5}
      a{color:#20654a} small{display:block;color:#526258} #status{overflow-wrap:anywhere}
      ol{max-height:36vh;overflow:auto;margin:6px 0;padding-left:24px} li{margin-bottom:5px}
    </style>
    <details open>
      <summary>小组成员名单搜索</summary>
      <form role="search">
        <select aria-label="搜索方式">
          <option value="id">ID / 主页链接</option>
          <option value="contains" selected>昵称包含</option>
          <option value="exact">昵称完全一致</option>
        </select>
        <input type="search" aria-label="搜索内容" placeholder="输入 ID、链接或昵称">
      </form>
      <div class="actions">
        <button id="start" type="button">读取名单</button>
        <button id="pause" type="button">暂停</button>
        <button id="export" type="button">导出名单</button>
        <button id="clear" type="button">清除缓存</button>
      </div>
      <small id="status" role="status"></small>
      <div id="message" role="status"></div>
      <ol id="results" hidden></ol>
      <button id="more" type="button" hidden>显示更多</button>
    </details>`;
  document.body.append(panel);
  const input = shadow.querySelector('input');
  const mode = shadow.querySelector('select');
  const start = shadow.getElementById('start');
  const pause = shadow.getElementById('pause');
  const exportButton = shadow.getElementById('export');
  const clear = shadow.getElementById('clear');
  const status = shadow.getElementById('status');
  const message = shadow.getElementById('message');
  const results = shadow.getElementById('results');
  const more = shadow.getElementById('more');
  const batchSize = 75;
  let limit = batchSize;
  let controller = null;
  let note = '';

  function emptyState() {
    return { next: 0, lastOffset: 0, pages: [], members: [], startedAt: 0, finishedAt: 0 };
  }
  const load = () => GM_getValue(key, null) || emptyState();
  let state = load();

  function exportFilename(date) {
    const groupRoot = path.slice(0, -'/members'.length);
    const groupId = decodeURIComponent(groupRoot.split('/').pop());
    let groupName = '';
    for (const link of document.querySelectorAll(
      '#content h1 a[href], #content h2 a[href], #content .group-name a[href], #content a[href*="/group/"]'
    )) {
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== groupRoot) continue;
      const name = (link.textContent.trim() || link.getAttribute('title')?.trim() || '')
        .replace(/^[>›»\s]+/, '').replace(/[>›»\s]+$/, '')
        .replace(/^(?:返回|回到)[「『“"]?/, '').replace(/[」』”"]$/, '').trim();
      if (name && !/^(?:返回|回到|小组(?:首页|主页)?|本小组|该小组|首页|主页|讨论区|小组讨论)$/.test(name)) {
        groupName = name;
        break;
      }
    }
    if (!groupName) {
      for (const label of [document.querySelector('#content h1')?.textContent, document.title]) {
        const text = label?.trim().replace(/\s*[-–—|｜_]\s*豆瓣(?:小组)?\s*$/, '') || '';
        const match = text.match(/^(.+?)\s*(?:的|[：:·\-–—|｜])?\s*(?:小组\s*)?(?:成员名单|成员列表|全部成员|成员|组员)(?:\s*[（(]\d+[）)])?$/);
        if (match?.[1].trim() && !/^(?:豆瓣|小组|豆瓣小组|全部)$/.test(match[1].trim())) {
          groupName = match[1].trim();
          break;
        }
      }
    }
    const safeName = (groupName || groupId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 120).replace(/[.\s]+$/, '') || '小组_' + groupId;
    const pad = value => String(value).padStart(2, '0');
    return `${safeName}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
  }

  function csvCell(value) {
    const text = String(value ?? '');
    // Avoid treating a member-supplied nickname or account alias as a spreadsheet formula.
    const safeText = /^(?:\s*[=+\-@＝＋－＠]|[\t\r\n])/.test(text) ? "'" + text : text;
    return '"' + safeText.replaceAll('"', '""') + '"';
  }

  function exportRoster(roster) {
    const completion = roster.finishedAt ? '已读完' : '未读完';
    const rows = [['昵称', '账号 ID', '个人主页', '所在页', '名单状态']];
    for (const member of roster.members) {
      rows.push([member.nickname || member.label, member.id || member.account,
        member.url, pageNumber(member.offset), completion]);
    }
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const blobUrl = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = exportFilename(new Date());
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  }

  function render() {
    const size = state.pages.length;
    const complete = state.finishedAt > 0;
    const progress = size ? `已读取 ${size} 页 · ${state.members.length} 个账号` : '还没有读取名单';
    start.disabled = Boolean(controller);
    pause.disabled = !controller || controller.signal.aborted;
    exportButton.disabled = !state.members.length;
    clear.disabled = Boolean(controller) || !size;
    start.textContent = complete ? '重新读取' : size ? '继续读取' : '读取名单';
    status.textContent = [
      complete ? progress + ' · 完成于 ' + dateLabel(state.finishedAt) : progress,
      note || (controller ? `正在读取第 ${pageNumber(state.next)} 页` :
        size && !complete ? '名单尚未读取完毕' : '')
    ].filter(Boolean).join('。');

    results.replaceChildren();
    results.hidden = true;
    more.hidden = true;
    const query = input.value.trim();
    message.textContent = '';
    if (!query) return;
    let needle = normalize(query);
    if (/^(?:https?:\/\/|\/people\/)/i.test(query)) {
      try { needle = normalize(profileKey(new URL(query, location.origin))); }
      catch { needle = ''; }
      if (!needle) {
        message.textContent = '请输入有效的豆瓣个人主页链接。';
        return;
      }
    }
    const byId = mode.value === 'id' || /^(?:https?:\/\/|\/people\/)/i.test(query);
    const matches = state.members.filter(member => {
      if (byId) return normalize(member.account) === needle || member.id === needle;
      const nickname = normalize(member.nickname || member.label);
      return mode.value === 'exact' ? nickname === needle : nickname.includes(needle);
    });
    if (!matches.length) {
      const hasMissingField = state.members.some(member => byId ?
        /^\d+$/.test(needle) && !member.id : !member.nickname && !member.label);
      message.textContent = complete
        ? hasMissingField
          ? '未找到匹配。部分条目缺少可用的' + (byId ? '数字 ID，可改用主页链接或昵称。' : '昵称，可改用 ID 或主页链接。')
          : '在本次读取的名单中未找到。'
        : '已读页面暂未找到，尚未查完。';
      return;
    }
    message.textContent = `找到 ${matches.length} 个匹配${complete ? '' : '（名单仍未读完）'}。`;
    results.hidden = false;
    more.hidden = matches.length <= limit;
    for (const member of matches.slice(0, limit)) {
      const li = document.createElement('li');
      const profile = document.createElement('a');
      profile.href = member.url;
      profile.target = '_blank';
      profile.rel = 'noopener noreferrer';
      profile.textContent = member.nickname || member.label || member.account;
      const pageLink = document.createElement('a');
      pageLink.href = new URL(path + '?start=' + member.offset, location.origin).href;
      pageLink.target = '_blank';
      pageLink.rel = 'noopener noreferrer';
      pageLink.textContent = `第 ${pageNumber(member.offset)} 页`;
      li.append(profile, ' · ' + (member.id || member.account) + ' · ', pageLink);
      results.append(li);
    }
  }

  function wait(ms, signal) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async function readRoster(signal) {
    const saved = load();
    state = saved.finishedAt ? emptyState() : saved;
    const members = new Map(state.members.map(member => [member.account, member]));
    try {
      while (!signal.aborted && state.next !== null) {
        const offset = state.next;
        const url = new URL(firstUrl);
        url.searchParams.set('start', String(offset));
        note = `正在读取第 ${pageNumber(offset)} 页`;
        render();
        const response = await fetch(url, {
          credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
        });
        if (!response.ok) throw new Error(`豆瓣返回 HTTP ${response.status}`);
        if (offsetOf(new URL(response.url)) !== offset) throw new Error('返回的分页与请求不一致');
        const html = await response.text();
        if (signal.aborted) break;
        const template = document.createElement('template');
        template.innerHTML = html;
        const page = readPage(template.content, url, offset, state.lastOffset);
        const signature = JSON.stringify(page.members.map(member => member.account).sort());
        if (state.pages.some(entry => entry.signature === signature)) {
          throw new Error('返回的成员与之前一整页重复，无法确认分页有效');
        }
        for (const member of page.members) {
          const previous = members.get(member.account);
          members.set(member.account, previous ? {
            ...previous,
            id: member.id || previous.id,
            nickname: member.nickname || previous.nickname,
            label: member.label || previous.label
          } : member);
        }
        const checkpoint = {
          next: page.next, lastOffset: page.lastOffset,
          pages: [...state.pages, { signature }],
          members: [...members.values()],
          startedAt: state.startedAt || Date.now(),
          finishedAt: page.next === null ? Date.now() : 0
        };
        GM_setValue(key, checkpoint);
        state = checkpoint;
        if (state.finishedAt) break;
        const delay = state.pages.length % 10 === 0 ? 5000 : 1500;
        note = `等待 ${delay / 1000} 秒后读取第 ${pageNumber(state.next)} 页`;
        render();
        await wait(delay, signal);
      }
      note = signal.aborted ? '已暂停，可以继续读取' : '';
      if (signal.aborted && !state.pages.length) state = saved;
    } catch (error) {
      const failedPage = pageNumber(state.next);
      if (!state.pages.length) state = saved;
      note = signal.aborted ? '已暂停，可以继续读取' :
        `第 ${failedPage} 页读取中断（${error.message}）。可在豆瓣确认该页正常打开后重试。`;
    }
  }

  async function withGroupLock(task) {
    if (navigator.locks) {
      await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (lock) await task();
        else note = '这个小组正在另一个标签页读取。';
      });
    } else {
      await task();
    }
  }

  start.onclick = async () => {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    render();
    try { await withGroupLock(() => readRoster(current.signal)); }
    catch (error) { note = '无法开始读取：' + error.message; }
    finally { controller = null; render(); }
  };
  pause.onclick = () => { controller?.abort(); };
  exportButton.onclick = () => {
    if (state.members.length) exportRoster(state);
  };
  clear.onclick = async () => {
    if (controller || !confirm('清除此小组保存的名单和读取进度？')) return;
    try {
      await withGroupLock(() => {
        GM_deleteValue(key);
        state = emptyState();
        note = '';
      });
    } catch (error) { note = '清除失败：' + error.message; }
    render();
  };
  const newQuery = () => { limit = batchSize; render(); };
  input.addEventListener('input', newQuery);
  mode.addEventListener('change', newQuery);
  shadow.querySelector('form').addEventListener('submit', event => event.preventDefault());
  more.onclick = () => { limit += batchSize; render(); };
  window.addEventListener('focus', () => {
    if (!controller) { state = load(); render(); }
  });
  render();
})();
