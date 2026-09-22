/**
 * Dashboard for talkincode-assets.
 *
 * Plain ES modules, no build step and no third-party runtime: the whole app is
 * one file that talks to /admin/api/*, which is only reachable through
 * Cloudflare Access (and re-verified by the worker).
 */

const state = {
  view: 'assets',
  me: null,
  stats: null,
  assets: [],
  total: 0,
  filters: { q: '', status: 'live', kind: '', tag: '', limit: 48, offset: 0 },
  layout: (() => {
    try { return localStorage.getItem('assets-layout') === 'list' ? 'list' : 'grid'; }
    catch { return 'grid'; }
  })(),
  selected: new Set(),
  tags: [],
  keys: [],
  abuse: [],
  settings: null,
  uploads: [],
};

const $ = (selector) => document.querySelector(selector);
const view = $('#view');
const modal = $('#modal');
const modalCard = $('#modal-card');

// ---------------------------------------------------------------- utilities

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtRelative(ms) {
  if (!ms) return '—';
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const units = [['天', 86400000], ['小时', 3600000], ['分钟', 60000], ['秒', 1000]];
  for (const [label, size] of units) {
    if (abs >= size) {
      const value = Math.floor(abs / size);
      return delta >= 0 ? `${value}${label}后` : `${value}${label}前`;
    }
  }
  return '刚刚';
}

function fmtTtl(ms) {
  if (ms === null || ms === undefined) return '永不过期';
  if (ms <= Date.now()) return '已过期';
  return fmtRelative(ms).replace('后', '后过期');
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('已复制', 'ok');
  }
}

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = new Error(data?.message || `HTTP ${response.status}`);
    error.code = data?.error;
    error.status = response.status;
    throw error;
  }
  return data;
}

function statusPill(asset) {
  return `<span class="pill ${asset.status}">${esc(asset.status)}</span>`;
}

function tagPills(tags, { clickable = false, active = '' } = {}) {
  if (!tags || tags.length === 0) return '';
  return tags.map((tag) => {
    const isActive = active && tag === active;
    if (clickable) {
      return `<button type="button" class="tag-chip${isActive ? ' active' : ''}" data-action="filter-tag" data-tag="${esc(tag)}">${esc(tag)}</button>`;
    }
    return `<span class="tag-chip">${esc(tag)}</span>`;
  }).join('');
}

function formatTagsInput(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

function setLayout(layout) {
  state.layout = layout === 'list' ? 'list' : 'grid';
  try { localStorage.setItem('assets-layout', state.layout); } catch { /* private mode */ }
}

function isSelected(hash) {
  return state.selected.has(hash);
}

function setSelected(hash, on) {
  if (on) state.selected.add(hash);
  else state.selected.delete(hash);
}

function clearSelection() {
  state.selected.clear();
}

function selectedAssets() {
  return state.assets.filter((asset) => state.selected.has(asset.hash));
}

function pruneSelection() {
  const visible = new Set(state.assets.map((asset) => asset.hash));
  for (const hash of [...state.selected]) {
    if (!visible.has(hash)) state.selected.delete(hash);
  }
}

function thumbHtml(asset, sizeClass = '') {
  if (asset.kind === 'image' && asset.status === 'live') {
    return `<img loading="lazy" src="${esc(asset.url)}" alt="" />`;
  }
  return `<span class="glyph ${sizeClass}">${esc(asset.kind)}</span>`;
}

// ---------------------------------------------------------------- rendering

function setTitle(title, tools = '') {
  $('#view-title').textContent = title;
  $('#view-tools').innerHTML = tools;
}

function renderShell() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === state.view);
  });
  if (state.view === 'assets') return renderAssets();
  if (state.view === 'upload') return renderUpload();
  if (state.view === 'keys') return renderKeys();
  if (state.view === 'abuse') return renderAbuse();
  if (state.view === 'settings') return renderSettings();
}

async function loadStats() {
  state.stats = await api('/admin/api/stats');
}

async function loadTags() {
  try {
    const data = await api('/admin/api/tags');
    state.tags = data.tags ?? [];
  } catch {
    state.tags = [];
  }
  renderTagNav();
}

function renderTagNav() {
  const list = $('#tag-nav-list');
  if (!list) return;
  const active = state.filters.tag;
  const allActive = !active;
  const items = [
    `<button type="button" class="tag-nav-item${allActive ? ' active' : ''}" data-action="filter-tag" data-tag="">全部 <span class="muted">${state.stats?.assets?.live ?? ''}</span></button>`,
    ...state.tags.map((row) => `
      <button type="button" class="tag-nav-item${active === row.tag ? ' active' : ''}" data-action="filter-tag" data-tag="${esc(row.tag)}">
        <span class="tag-nav-name" title="${esc(row.tag)}">${esc(row.tag)}</span>
        <span class="muted">${row.count}</span>
      </button>`),
  ];
  list.innerHTML = items.join('') || '<div class="muted small">暂无标签</div>';
}

function selectTag(tag) {
  state.filters.tag = tag || '';
  state.filters.offset = 0;
  state.view = 'assets';
  renderTagNav();
  renderShell().catch(showError);
}

async function loadAssets() {
  const { q, status, kind, tag, limit, offset } = state.filters;
  const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  if (tag) params.set('tag', tag);
  const data = await api(`/admin/api/assets?${params}`);
  state.assets = data.assets;
  state.total = data.total;
}

async function renderAssets() {
  const tagFilter = state.filters.tag;
  const layout = state.layout;
  setTitle('资产', `
    <div class="layout-toggle" role="group" aria-label="视图">
      <button type="button" class="btn small${layout === 'grid' ? ' active' : ''}" id="layout-grid">网格</button>
      <button type="button" class="btn small${layout === 'list' ? ' active' : ''}" id="layout-list">列表</button>
    </div>
    <input type="search" id="q" placeholder="搜索 hash / 文件名 / 标签" value="${esc(state.filters.q)}" />
    <select id="status">
      ${['live', 'expired', 'deleted', 'all'].map((value) =>
        `<option value="${value}"${state.filters.status === value ? ' selected' : ''}>${
          { live: '有效', expired: '已过期', deleted: '已删除', all: '全部' }[value]}</option>`).join('')}
    </select>
    <select id="kind">
      ${['', 'image', 'audio', 'video', 'text', 'other'].map((value) =>
        `<option value="${value}"${state.filters.kind === value ? ' selected' : ''}>${
          { '': '全部类型', image: '图片', audio: '音频', video: '视频', text: '文本', other: '其他' }[value]}</option>`).join('')}
    </select>
    <button class="btn" id="refresh">刷新</button>
  `);
  view.innerHTML = `<div class="loading">加载中…</div>`;

  await Promise.all([loadStats(), loadAssets(), loadTags()]);
  pruneSelection();
  const stats = state.stats;
  renderTagNav();

  const batchBar = `
    <div class="batch-bar${state.selected.size ? '' : ' is-empty'}" id="batch-bar">
      <span class="batch-count">已选 <strong id="batch-count">${state.selected.size}</strong></span>
      <label class="field batch-field"><span>标签</span>
        <input type="text" id="batch-tags" placeholder="逗号分隔" list="batch-tag-suggestions" />
      </label>
      <select id="batch-tags-mode" title="标签写入方式">
        <option value="replace">替换</option>
        <option value="add">追加</option>
        <option value="remove">移除</option>
      </select>
      <button class="btn" id="batch-tags-save" ${state.selected.size ? '' : 'disabled'}>改标签</button>
      <label class="field batch-field"><span>过期</span>
        <select id="batch-expire">
          <option value="">选择…</option>
          <option value="1h">1 小时</option>
          <option value="1d">1 天</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
          <option value="never">永不过期</option>
        </select>
      </label>
      <button class="btn" id="batch-expire-save" ${state.selected.size ? '' : 'disabled'}>改过期</button>
      <button class="btn" id="batch-rotate" ${state.selected.size ? '' : 'disabled'}>换 hash</button>
      <button class="btn" id="batch-copy" ${state.selected.size ? '' : 'disabled'}>复制 URL</button>
      <button class="btn ghost" id="batch-clear" ${state.selected.size ? '' : 'disabled'}>取消选择</button>
      <datalist id="batch-tag-suggestions">${state.tags.map((row) => `<option value="${esc(row.tag)}"></option>`).join('')}</datalist>
    </div>
  `;

  const list = layout === 'list' ? renderAssetList(tagFilter) : renderAssetGrid(tagFilter);

  view.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>${stats.assets.live}</b><span>有效资产</span></div>
      <div class="stat"><b>${fmtSize(stats.assets.live_bytes)}</b><span>占用空间</span></div>
      <div class="stat"><b>${stats.assets.expired}</b><span>已过期</span></div>
      <div class="stat"><b>${stats.assets.downloads}</b><span>累计下载</span></div>
      <div class="stat"><b>${stats.blocked_sources}</b><span>封禁来源</span></div>
    </div>
    ${tagFilter ? `<div class="filter-banner">正在筛选标签 <strong>${esc(tagFilter)}</strong> <button class="btn ghost small" data-action="filter-tag" data-tag="">清除</button></div>` : ''}
    ${batchBar}
    ${list}
    <p class="muted small assets-footer">共 ${state.total} 条 · 显示 ${state.assets.length} 条</p>
  `;

  wireAssetChrome();
}

function renderAssetGrid(tagFilter) {
  if (state.assets.length === 0) return '<div class="empty">没有匹配的资产</div>';
  const cards = state.assets.map((asset) => `
    <article class="card${isSelected(asset.hash) ? ' is-selected' : ''}" data-hash="${esc(asset.hash)}">
      <label class="select-box" title="选择">
        <input type="checkbox" data-action="toggle-select" data-hash="${esc(asset.hash)}" ${isSelected(asset.hash) ? 'checked' : ''} />
      </label>
      <div class="thumb" data-action="open" data-hash="${esc(asset.hash)}">
        ${thumbHtml(asset)}
      </div>
      <div class="card-body">
        <div class="card-title">
          <span class="card-name" title="${esc(asset.filename)}">${esc(asset.filename)}</span>
          ${statusPill(asset)}
        </div>
        <div class="hash" data-action="copy" data-copy="${esc(asset.url)}" title="${esc(asset.url)}">${esc(asset.hash)}</div>
        ${asset.tags?.length ? `<div class="tag-row">${tagPills(asset.tags, { clickable: true, active: tagFilter })}</div>` : ''}
        <div class="meta-row">
          <span>${fmtSize(asset.size)}</span>
          <span>${esc(asset.kind)}</span>
          <span>${asset.expires_at ? fmtTtl(asset.expires_at) : '永不过期'}</span>
          <span>${fmtRelative(asset.created_at)}</span>
        </div>
        <div class="card-actions">
          <button class="btn" data-action="copy" data-copy="${esc(asset.url)}">复制链接</button>
          <button class="btn" data-action="open" data-hash="${esc(asset.hash)}">详情</button>
          <a class="btn" href="${esc(asset.url)}" target="_blank" rel="noreferrer">打开</a>
        </div>
      </div>
    </article>
  `).join('');
  return `<div class="asset-grid">${cards}</div>`;
}

function renderAssetList(tagFilter) {
  if (state.assets.length === 0) return '<div class="empty">没有匹配的资产</div>';
  const allSelected = state.assets.length > 0 && state.assets.every((asset) => isSelected(asset.hash));
  const rows = state.assets.map((asset) => `
    <tr class="${isSelected(asset.hash) ? 'is-selected' : ''}" data-hash="${esc(asset.hash)}">
      <td class="col-check">
        <input type="checkbox" data-action="toggle-select" data-hash="${esc(asset.hash)}" ${isSelected(asset.hash) ? 'checked' : ''} />
      </td>
      <td class="col-thumb">
        <button type="button" class="list-thumb" data-action="open" data-hash="${esc(asset.hash)}" title="${esc(asset.filename)}">
          ${thumbHtml(asset, 'glyph-sm')}
        </button>
      </td>
      <td class="col-name">
        <button type="button" class="linkish" data-action="open" data-hash="${esc(asset.hash)}" title="${esc(asset.filename)}">${esc(asset.filename)}</button>
        <div class="hash" data-action="copy" data-copy="${esc(asset.url)}" title="${esc(asset.url)}">${esc(asset.hash)}</div>
      </td>
      <td class="col-tags">${asset.tags?.length ? tagPills(asset.tags, { clickable: true, active: tagFilter }) : '<span class="muted">—</span>'}</td>
      <td class="col-meta"><span>${fmtSize(asset.size)}</span><span class="muted">${esc(asset.kind)}</span></td>
      <td class="col-expiry">${asset.expires_at ? fmtTtl(asset.expires_at) : '永不过期'}</td>
      <td class="col-status">${statusPill(asset)}</td>
      <td class="col-actions">
        <button class="btn small" data-action="copy" data-copy="${esc(asset.url)}">复制</button>
        <a class="btn small" href="${esc(asset.url)}" target="_blank" rel="noreferrer">打开</a>
      </td>
    </tr>
  `).join('');
  return `
    <div class="asset-table-wrap">
      <table class="asset-table">
        <thead>
          <tr>
            <th class="col-check"><input type="checkbox" id="select-all" ${allSelected ? 'checked' : ''} title="全选当前页" /></th>
            <th class="col-thumb">预览</th>
            <th class="col-name">文件</th>
            <th class="col-tags">标签</th>
            <th class="col-meta">大小</th>
            <th class="col-expiry">过期</th>
            <th class="col-status">状态</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function syncBatchBar() {
  const count = state.selected.size;
  const bar = $('#batch-bar');
  if (!bar) return;
  bar.classList.toggle('is-empty', count === 0);
  const countNode = $('#batch-count');
  if (countNode) countNode.textContent = String(count);
  ['batch-tags-save', 'batch-expire-save', 'batch-rotate', 'batch-copy', 'batch-clear'].forEach((id) => {
    const node = $(`#${id}`);
    if (node) node.disabled = count === 0;
  });
  document.querySelectorAll('.card, .asset-table tbody tr').forEach((node) => {
    const hash = node.dataset.hash;
    if (!hash) return;
    node.classList.toggle('is-selected', isSelected(hash));
  });
  document.querySelectorAll('[data-action="toggle-select"]').forEach((node) => {
    node.checked = isSelected(node.dataset.hash);
  });
  const selectAll = $('#select-all');
  if (selectAll) {
    selectAll.checked = state.assets.length > 0 && state.assets.every((asset) => isSelected(asset.hash));
  }
}

function wireAssetChrome() {
  $('#q').addEventListener('change', (event) => {
    state.filters.q = event.target.value.trim();
    state.filters.offset = 0;
    renderAssets().catch(showError);
  });
  $('#status').addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    state.filters.offset = 0;
    renderAssets().catch(showError);
  });
  $('#kind').addEventListener('change', (event) => {
    state.filters.kind = event.target.value;
    state.filters.offset = 0;
    renderAssets().catch(showError);
  });
  $('#refresh').addEventListener('click', () => renderAssets().catch(showError));
  $('#layout-grid')?.addEventListener('click', () => {
    if (state.layout === 'grid') return;
    setLayout('grid');
    renderAssets().catch(showError);
  });
  $('#layout-list')?.addEventListener('click', () => {
    if (state.layout === 'list') return;
    setLayout('list');
    renderAssets().catch(showError);
  });
  $('#select-all')?.addEventListener('change', (event) => {
    const on = event.target.checked;
    for (const asset of state.assets) setSelected(asset.hash, on);
    syncBatchBar();
  });
  $('#batch-clear')?.addEventListener('click', () => {
    clearSelection();
    syncBatchBar();
  });
  $('#batch-copy')?.addEventListener('click', async () => {
    const urls = selectedAssets().map((asset) => asset.url);
    if (urls.length === 0) return;
    await copy(urls.join('\n'));
    toast(`已复制 ${urls.length} 条 URL`, 'ok');
  });
  $('#batch-tags-save')?.addEventListener('click', () => runBatchUpdate({
    tags: $('#batch-tags').value,
    tags_mode: $('#batch-tags-mode').value,
  }).catch(showError));
  $('#batch-expire-save')?.addEventListener('click', () => {
    const value = $('#batch-expire').value;
    if (!value) return toast('请选择过期时间', 'error');
    const body = value === 'never' ? { never: true } : { expires_in: value };
    runBatchUpdate(body).catch(showError);
  });
  $('#batch-rotate')?.addEventListener('click', async () => {
    if (!confirm(`将为选中的 ${state.selected.size} 个资产生成新 hash，旧链接立即失效。继续？`)) return;
    await runBatchUpdate({ rotate: true }).catch(showError);
  });
}

async function runBatchUpdate(patch) {
  const hashes = [...state.selected];
  if (hashes.length === 0) return;
  const data = await api('/admin/api/assets/batch', {
    method: 'POST',
    body: { hashes, ...patch },
  });
  clearSelection();
  if (data.results) {
    for (const row of data.results) state.selected.delete(row.previous_hash);
  }
  toast(`已更新 ${data.updated} 项${data.missing?.length ? `，${data.missing.length} 项未找到` : ''}`, 'ok');
  await Promise.all([loadTags(), renderAssets()]);
}

function uploadRow(item) {
  return `
    <div class="upload-row">
      <div>
        <div>${esc(item.name)}</div>
        <div class="bar"><i style="width:${item.percent}%"></i></div>
        <div class="muted small">${esc(item.status)}</div>
      </div>
      <div>${item.url ? `<button class="btn" data-action="copy" data-copy="${esc(item.url)}">复制链接</button>` : ''}</div>
    </div>
  `;
}

function renderUpload() {
  setTitle('上传', '<span class="muted small">通过 dashboard 上传无需密钥；agent 请使用 CLI + 上传密钥</span>');
  loadTags().catch(() => undefined);
  view.innerHTML = `
    <div class="panel">
      <div class="dropzone" id="dropzone" tabindex="0">
        <strong>拖拽文件到这里，点击选择，或直接粘贴图片</strong>
        <span class="muted small">默认过期时间 ${state.stats?.policy?.default_ttl_days ?? 7} 天 · 单文件上限 ${fmtSize(state.stats?.policy?.max_upload_bytes ?? 0)} · Ctrl/⌘+V 粘贴截图</span>
      </div>
      <input type="file" id="file" multiple hidden />
      <div class="row-form" style="margin-top:14px">
        <label class="field"><span>过期时间</span>
          <select id="ttl">
            <option value="default">默认</option>
            <option value="1h">1 小时</option>
            <option value="1d">1 天</option>
            <option value="7d">7 天</option>
            <option value="30d">30 天</option>
            <option value="never">永不过期</option>
          </select>
        </label>
        <label class="field"><span>显示文件名（可选）</span><input type="text" id="filename" placeholder="留空则用原文件名" /></label>
        <label class="field"><span>标签（可选）</span><input type="text" id="tags" placeholder="逗号分隔，如 课件, PDF" list="tag-suggestions" /></label>
        <label class="field"><span>备注（可选）</span><input type="text" id="note" placeholder="用途说明" /></label>
      </div>
      <datalist id="tag-suggestions">${state.tags.map((row) => `<option value="${esc(row.tag)}"></option>`).join('')}</datalist>
      <div class="upload-list" id="uploads">${state.uploads.map(uploadRow).join('')}</div>
    </div>
  `;
  const dropzone = $('#dropzone');
  const fileInput = $('#file');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    queueUploads([...fileInput.files]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('hot'); }));
  dropzone.addEventListener('drop', (event) => queueUploads([...event.dataTransfer.files]));
}

function filesFromClipboard(clipboardData) {
  if (!clipboardData) return [];
  const files = [];
  const items = clipboardData.items ? [...clipboardData.items] : [];
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    files.push(new File([blob], `paste-${stamp}.${ext}`, { type: blob.type || 'image/png' }));
  }
  if (files.length === 0 && clipboardData.files?.length) {
    for (const file of clipboardData.files) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  return files;
}

document.addEventListener('paste', (event) => {
  if (state.view !== 'upload') return;
  const files = filesFromClipboard(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  $('#dropzone')?.classList.add('hot');
  setTimeout(() => $('#dropzone')?.classList.remove('hot'), 400);
  runUploads(files).catch(showError);
});

async function queueUploads(files) {
  for (const file of files) {
    const item = { name: file.name, percent: 0, status: '上传中…', url: null };
    state.uploads.unshift(item);
    if (state.view === 'upload') $('#uploads').innerHTML = state.uploads.map(uploadRow).join('');
    try {
      const params = new URLSearchParams();
      const filename = $('#filename')?.value.trim();
      if (filename && files.length === 1) params.set('filename', filename);
      const note = $('#note')?.value.trim();
      if (note) params.set('note', note);
      const tags = $('#tags')?.value.trim();
      if (tags) params.set('tags', tags);
      const ttl = $('#ttl')?.value ?? 'default';
      if (ttl !== 'default') params.set('expires_in', ttl);
      const result = await uploadFile(file, params, (percent) => {
        item.percent = percent;
        if (state.view === 'upload') $('#uploads').innerHTML = state.uploads.map(uploadRow).join('');
      });
      item.percent = 100;
      item.url = result.url;
      item.status = `完成 · ${result.hash}`;
      toast(`上传成功：${result.hash}`, 'ok');
      await Promise.all([loadStats(), loadTags()]);
    } catch (error) {
      item.status = `失败：${error.message}`;
      toast(error.message, 'error');
    }
    if (state.view === 'upload') $('#uploads').innerHTML = state.uploads.map(uploadRow).join('');
  }
}

function uploadFile(file, params, onProgress) {
  return new Promise((resolve, reject) => {
    // Filename goes in the query string: XMLHttpRequest headers are ISO-8859-1
    // only, so a Chinese name in X-Filename throws before the request is sent.
    if (!params.has('filename')) params.set('filename', file.name);
    const request = new XMLHttpRequest();
    request.open('POST', `/admin/api/assets?${params}`);
    request.withCredentials = true;
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(request.responseText); } catch { data = null; }
      if (request.status >= 200 && request.status < 300 && data) resolve(data);
      else reject(new Error(data?.message || `HTTP ${request.status}`));
    });
    request.addEventListener('error', () => reject(new Error('网络错误')));
    request.send(file);
  });
}

async function renderKeys() {
  setTitle('上传密钥', '<span class="muted small">密钥只在创建时显示一次，服务端仅保存 SHA-256</span>');
  const data = await api('/admin/api/keys');
  state.keys = data.keys;
  view.innerHTML = `
    <div class="panel">
      <h2>新建密钥</h2>
      <div class="row-form">
        <label class="field"><span>名称</span><input type="text" id="key-name" placeholder="例如 agent-laptop" /></label>
        <button class="btn primary" id="key-create">创建</button>
      </div>
      <div id="key-secret"></div>
    </div>
    <div class="panel">
      <h2>密钥列表</h2>
      <table>
        <thead><tr><th>名称</th><th>前缀</th><th>创建</th><th>最近使用</th><th>次数</th><th>状态</th><th></th></tr></thead>
        <tbody>
          ${state.keys.map((key) => `
            <tr>
              <td>${esc(key.name)}</td>
              <td class="mono">${esc(key.prefix)}…</td>
              <td class="small muted">${fmtTime(key.created_at)}<br />${esc(key.created_by ?? '')}</td>
              <td class="small muted">${key.last_used_at ? fmtTime(key.last_used_at) : '—'}<br />${esc(key.last_used_ip ?? '')}</td>
              <td>${key.use_count}</td>
              <td>${key.revoked_at ? '<span class="pill deleted">已吊销</span>' : '<span class="pill live">有效</span>'}</td>
              <td>${key.revoked_at ? '' : `<button class="btn danger" data-action="revoke-key" data-id="${esc(key.id)}">吊销</button>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  $('#key-create').addEventListener('click', async () => {
    const name = $('#key-name').value.trim();
    if (!name) return toast('请填写名称', 'error');
    try {
      const created = await api('/admin/api/keys', { method: 'POST', body: { name } });
      $('#key-secret').innerHTML = `
        <div class="panel" style="margin-top:14px;border-color:rgba(62,207,142,.4)">
          <h2>密钥（仅显示一次）</h2>
          <div class="mono" style="word-break:break-all">${esc(created.secret)}</div>
          <div style="margin-top:10px"><button class="btn" data-action="copy" data-copy="${esc(created.secret)}">复制</button></div>
        </div>`;
      toast('密钥已创建', 'ok');
      await renderKeys();
    } catch (error) {
      showError(error);
    }
  });
}

async function renderAbuse() {
  setTitle('安全防护', '<span class="muted small">连续猜测 hash 或上传密钥的来源会被自动封禁，且逐次加倍</span>');
  const data = await api('/admin/api/abuse');
  state.abuse = data.blocked;
  view.innerHTML = `
    <div class="panel">
      <h2>封禁策略</h2>
      <p class="muted small">
        同一来源网络（IPv4 /24、IPv6 /64）在统计窗口内猜错 ${esc(data.threshold)} 次即触发封禁，
        每再犯一次封禁时长按 <code class="inline">ABUSE_BAN_SCHEDULE</code> 递增（默认 5 分钟 → 1 小时 → 1 天 → 7 天）。
        只有失败的查找会被计入，正常下载不受影响。
      </p>
    </div>
    <div class="panel">
      <h2>封禁来源 <span class="muted small">生效中 ${data.active} / 共 ${state.abuse.length}</span></h2>
      ${state.abuse.length === 0 ? '<div class="empty">暂无封禁来源</div>' : `
      <table>
        <thead><tr><th>来源</th><th>状态</th><th>违规次数</th><th>累计猜错</th><th>解封时间</th><th>最后动作</th><th></th></tr></thead>
        <tbody>
          ${state.abuse.map((row) => `
            <tr>
              <td class="mono">${esc(row.source)}</td>
              <td>${row.active ? '<span class="pill deleted">生效中</span>' : '<span class="pill">已过期</span>'}</td>
              <td>${row.strikes}</td>
              <td>${row.misses}</td>
              <td class="small">${fmtTime(row.blocked_until)}<br /><span class="muted">${fmtRelative(row.blocked_until)}</span></td>
              <td class="small muted">${esc(row.detail ?? '')}</td>
              <td><button class="btn" data-action="unblock" data-source="${esc(row.source)}">${row.active ? '解封' : '清除'}</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="panel">
      <h2>防护分层</h2>
      <p class="muted small">
        1）边缘限流：每来源每分钟请求预算，失败请求预算更紧（<code class="inline">wrangler.toml</code> 的 ratelimits）。<br />
        2）状态化封禁：AbuseGuard Durable Object 按来源网络记账，跨部署保留。<br />
        3）hash 本身 128 位随机，穷举不可行；封禁针对的是资源滥用而非可猜性。
      </p>
    </div>
  `;
}

async function renderSettings() {
  setTitle('设置', '<span class="muted small">运行时策略存于 D1；wrangler.toml 中的值作为兜底</span>');
  const data = await api('/admin/api/settings');
  state.settings = data;
  const editable = data.settings;
  view.innerHTML = `
    <div class="panel">
      <h2>上传策略</h2>
      <div class="row-form">
        <label class="field"><span>默认过期天数（0 = 永不过期）</span><input type="number" id="s-ttl" min="0" value="${esc(editable.default_ttl_days ?? '7')}" /></label>
        <label class="field"><span>单文件上限（字节）</span><input type="number" id="s-max" min="0" value="${esc(editable.max_upload_bytes ?? '104857600')}" /></label>
        <label class="field"><span>回收站保留天数</span><input type="number" id="s-trash" min="0" value="${esc(editable.trash_retention_days ?? '7')}" /></label>
        <button class="btn primary" id="s-save">保存</button>
      </div>
      <p class="hint">回收站保留 = 手动删除后字节仍在 R2 中可恢复的天数；过期资产会立即释放。</p>
    </div>
    <div class="panel">
      <h2>部署环境</h2>
      <dl class="kv">
        <dt>外链前缀</dt><dd class="mono">${esc(state.me?.public_base_url ?? '')}</dd>
        <dt>Access 状态</dt><dd>${data.read_only.access_configured ? `<span class="pill live">已配置</span>` : `<span class="pill deleted">未配置</span>`}</dd>
        <dt>允许登录</dt><dd class="mono">${esc(data.read_only.access_allowed_emails)}</dd>
        <dt>缓存 TTL</dt><dd>${esc(data.read_only.cache_ttl_seconds)} 秒（删除/过期传播上限）</dd>
        <dt>封禁阈值</dt><dd>${esc(data.read_only.abuse_miss_threshold)} 次失败</dd>
      </dl>
    </div>
  `;
  $('#s-save').addEventListener('click', async () => {
    try {
      await api('/admin/api/settings', {
        method: 'PATCH',
        body: {
          default_ttl_days: Number($('#s-ttl').value),
          max_upload_bytes: Number($('#s-max').value),
          trash_retention_days: Number($('#s-trash').value),
        },
      });
      toast('已保存', 'ok');
      await renderSettings();
    } catch (error) {
      showError(error);
    }
  });
}

// ---------------------------------------------------------------- detail modal

async function openAsset(hash) {
  modal.hidden = false;
  modalCard.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api(`/admin/api/assets/${hash}`);
    const asset = data.asset;
    const preview = {
      image: `<img src="${esc(asset.url)}" alt="${esc(asset.filename)}" />`,
      video: `<video src="${esc(asset.url)}" controls preload="metadata"></video>`,
      audio: `<audio src="${esc(asset.url)}" controls preload="metadata"></audio>`,
      text: `<pre>点击“打开”查看内容</pre>`,
    }[asset.kind] ?? '<span class="muted">无内嵌预览</span>';

    modalCard.innerHTML = `
      <div class="modal-head">
        <div>
          <h2 style="margin:0 0 4px">${esc(asset.filename)}</h2>
          <div class="mono muted">${esc(asset.hash)}</div>
        </div>
        <button class="btn" data-close="1">关闭</button>
      </div>
      <div class="preview">${preview}</div>
      <dl class="kv">
        <dt>状态</dt><dd>${statusPill(asset)} ${asset.expires_at ? esc(fmtTtl(asset.expires_at)) : '永不过期'}</dd>
        <dt>外链</dt><dd><a href="${esc(asset.url)}" target="_blank" rel="noreferrer" class="mono">${esc(asset.url)}</a></dd>
        <dt>大小</dt><dd>${fmtSize(asset.size)} · ${esc(asset.content_type)}</dd>
        <dt>创建</dt><dd>${fmtTime(asset.created_at)} · ${fmtRelative(asset.created_at)}</dd>
        <dt>来源</dt><dd>${esc(asset.key_id ? `密钥 ${asset.key_id}` : 'dashboard')} · ${esc(asset.uploader_ip ?? '—')}</dd>
        <dt>下载</dt><dd>${asset.downloads} 次 · 最近 ${asset.last_access_at ? fmtRelative(asset.last_access_at) : '—'}</dd>
        <dt>备注</dt><dd>${esc(asset.note ?? '—')}</dd>
        <dt>标签</dt><dd>${asset.tags?.length ? tagPills(asset.tags, { clickable: true, active: state.filters.tag }) : '<span class="muted">无</span>'}</dd>
      </dl>
      <div class="row-form" style="margin-top:16px">
        <label class="field grow"><span>编辑标签</span>
          <input type="text" id="m-tags" value="${esc(formatTagsInput(asset.tags))}" placeholder="逗号分隔，留空清除" list="m-tag-suggestions" />
        </label>
        <button class="btn" id="m-tags-save">保存标签</button>
        <datalist id="m-tag-suggestions">${state.tags.map((row) => `<option value="${esc(row.tag)}"></option>`).join('')}</datalist>
      </div>
      <div class="row-form" style="margin-top:8px">
        <button class="btn" data-action="copy" data-copy="${esc(asset.url)}">复制链接</button>
        <a class="btn" href="${esc(asset.url)}" target="_blank" rel="noreferrer">打开</a>
        <a class="btn" href="${esc(asset.url)}?dl=1" target="_blank" rel="noreferrer">下载</a>
        <label class="field"><span>修改过期</span>
          <select id="m-expire">
            <option value="">选择…</option>
            <option value="1h">1 小时</option>
            <option value="1d">1 天</option>
            <option value="7d">7 天</option>
            <option value="30d">30 天</option>
            <option value="1y">365 天</option>
            <option value="never">永不过期</option>
          </select>
        </label>
        <button class="btn" id="m-rotate">更换 hash</button>
        ${asset.deleted_at
          ? '<button class="btn primary" id="m-restore">恢复</button>'
          : '<button class="btn danger" id="m-delete">删除</button>'}
        <button class="btn danger" id="m-purge">彻底删除</button>
      </div>
      <div class="panel" style="margin-top:16px">
        <h2>操作记录</h2>
        ${data.audit.length === 0 ? '<div class="muted small">暂无记录</div>' : `<table><tbody>
          ${data.audit.map((entry) => `<tr>
            <td class="small muted" style="width:170px">${fmtTime(entry.at)}</td>
            <td>${esc(entry.action)}</td>
            <td class="small">${esc(entry.actor)}</td>
            <td class="small muted">${esc(entry.detail ?? '')}</td>
          </tr>`).join('')}
        </tbody></table>`}
      </div>
    `;

    $('#m-expire').addEventListener('change', async (event) => {
      const value = event.target.value;
      if (!value) return;
      try {
        await api(`/admin/api/assets/${asset.hash}`, {
          method: 'PATCH',
          body: value === 'never' ? { never: true } : { expires_in: value },
        });
        toast('过期时间已更新', 'ok');
        await openAsset(asset.hash);
        if (state.view === 'assets') await renderAssets();
      } catch (error) { showError(error); }
    });

    $('#m-tags-save').addEventListener('click', async () => {
      try {
        await api(`/admin/api/assets/${asset.hash}`, {
          method: 'PATCH',
          body: { tags: $('#m-tags').value },
        });
        toast('标签已更新', 'ok');
        await loadTags();
        await openAsset(asset.hash);
        if (state.view === 'assets') await renderAssets();
      } catch (error) { showError(error); }
    });

    $('#m-rotate').addEventListener('click', async () => {
      const chosen = prompt('输入新的 hash（留空则随机生成）', '');
      if (chosen === null) return;
      try {
        const result = await api(`/admin/api/assets/${asset.hash}/rotate`, {
          method: 'POST',
          body: chosen.trim() ? { hash: chosen.trim() } : {},
        });
        toast(`新链接：${result.asset.url}`, 'ok');
        await copy(result.asset.url);
        modal.hidden = true;
        if (state.view === 'assets') await renderAssets();
      } catch (error) { showError(error); }
    });

    $('#m-delete')?.addEventListener('click', async () => {
      if (!confirm('删除后外链立即失效（字节保留在回收站，可恢复）')) return;
      try {
        await api(`/admin/api/assets/${asset.hash}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        modal.hidden = true;
        await renderAssets();
      } catch (error) { showError(error); }
    });

    $('#m-restore')?.addEventListener('click', async () => {
      try {
        const chosen = prompt('恢复后新的过期时间（如 7d；留空保持原值）', '7d');
        const body = chosen === null ? {} : chosen.trim() === '' ? {} : { expires_in: chosen.trim() };
        await api(`/admin/api/assets/${asset.hash}/restore`, { method: 'POST', body });
        toast('已恢复', 'ok');
        modal.hidden = true;
        await renderAssets();
      } catch (error) { showError(error); }
    });

    $('#m-purge').addEventListener('click', async () => {
      if (!confirm('彻底删除会移除 R2 中的字节与数据库记录，不可恢复')) return;
      try {
        await api(`/admin/api/assets/${asset.hash}?purge=1`, { method: 'DELETE' });
        toast('已彻底删除', 'ok');
        modal.hidden = true;
        await renderAssets();
      } catch (error) { showError(error); }
    });
  } catch (error) {
    modalCard.innerHTML = `<div class="panel"><h2>无法打开</h2><p class="muted">${esc(error.message)}</p>
      <button class="btn" data-close="1">关闭</button></div>`;
  }
}

// ---------------------------------------------------------------- events

function showError(error) {
  if (error.status === 401 || error.status === 403) {
    view.innerHTML = `<div class="panel"><h2>没有访问权限</h2>
      <p class="muted">${esc(error.message)}</p>
      <p class="muted small">本页面位于 Cloudflare Access 之后。如果是首次访问，请重新登录后再试。</p>
      <button class="btn primary" onclick="location.reload()">重新登录</button></div>`;
    return;
  }
  if (error.code === 'access_not_configured') {
    view.innerHTML = `<div class="panel"><h2>Access 尚未配置</h2>
      <p class="muted">${esc(error.message)}</p>
      <p class="muted small">按 <code class="inline">docs/DEPLOY.md</code> 创建 Access 应用，并把 ACCESS_AUD / ACCESS_TEAM_DOMAIN 写入 wrangler.toml 后重新部署。</p></div>`;
    return;
  }
  toast(error.message, 'error');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (target) {
    const action = target.dataset.action;
    if (action === 'copy') return copy(target.dataset.copy);
    if (action === 'open') return openAsset(target.dataset.hash);
    if (action === 'toggle-select') {
      setSelected(target.dataset.hash, target.checked);
      syncBatchBar();
      return;
    }
    if (action === 'filter-tag') {
      modal.hidden = true;
      selectTag(target.dataset.tag ?? '');
      return;
    }
    if (action === 'revoke-key') {
      if (!confirm('吊销后使用该密钥的上传会立即失败')) return;
      try {
        await api(`/admin/api/keys/${target.dataset.id}`, { method: 'DELETE' });
        toast('已吊销', 'ok');
        await renderKeys();
      } catch (error) { showError(error); }
      return;
    }
    if (action === 'unblock') {
      try {
        await api(`/admin/api/abuse/${encodeURIComponent(target.dataset.source)}`, { method: 'DELETE' });
        toast('已解封', 'ok');
        await renderAbuse();
      } catch (error) { showError(error); }
      return;
    }
  }
  if (event.target.closest('[data-close]')) {
    modal.hidden = true;
  }
});

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('assets-theme', theme); } catch (e) { /* private mode */ }
  $('#theme-toggle').textContent = theme === 'light' ? '深色模式' : '浅色模式';
}

$('#theme-toggle').addEventListener('click', () => {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
});

$('#nav').addEventListener('click', (event) => {
  const item = event.target.closest('.nav-item');
  if (!item) return;
  state.view = item.dataset.view;
  renderShell().catch(showError);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') modal.hidden = true;
});

async function boot() {
  setTheme(currentTheme());
  try {
    state.me = await api('/admin/api/me');
    $('#who').textContent = state.me.email ?? state.me.service_token ?? state.me.actor;
    $('#base-link').textContent = state.me.public_base_url;
    $('#base-link').href = state.me.public_base_url;
    $('#brand-host').textContent = new URL(state.me.public_base_url).host;
    await loadStats();
    await loadTags();
    await renderShell();
  } catch (error) {
    showError(error);
  }
}

boot();
