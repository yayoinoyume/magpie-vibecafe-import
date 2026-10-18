// 配置页面：读写插件自己的 options。
//
// 页面跑在沙盒里，不能联网、不能读文件。所有数据来自：
//   - catalog.js   编译时内联的工具清单
//   - magpie.options.get()  当前配置
//
// 保存走 magpie.options.set()，写回 magpie 的 plugins.json。

(async () => {
  const V = globalThis.VibecafeView;
  const CATALOG = globalThis.VIBECAFE_CATALOG || {};
  const $ = (id) => document.getElementById(id);

  await magpie.ready;

  let options = {};
  try {
    options = (await magpie.options.get()) || {};
  } catch {
    // 读不到就按默认（全关）显示，保存时再试。
  }

  const state = {
    view: V.buildView(options.sources || {}, CATALOG),
    includeOthers: options.includeOthers === true,
    dirty: false,
  };

  const status = (text, tone = '') => {
    const el = $('status');
    el.textContent = text;
    el.className = 'status' + (tone ? ' ' + tone : '');
  };

  function paintSummary() {
    $('summary').textContent = V.summarize(state.view, {
      includeOthers: state.includeOthers,
    });
  }

  function paintGroups() {
    const host = $('groups');
    host.replaceChildren();

    for (const [key, meta] of Object.entries(V.GROUPS)) {
      const items = state.view.groups[key];
      if (!items || items.length === 0) continue;

      const section = document.createElement('section');
      section.className = 'group';
      section.dataset.tone = meta.tone;

      const head = document.createElement('div');
      head.className = 'group-head';
      const h2 = document.createElement('h2');
      h2.textContent = meta.title;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${items.filter((x) => x.enabled).length}/${items.length}`;
      head.append(h2, count);

      const hint = document.createElement('p');
      hint.className = 'group-hint';
      hint.textContent = meta.hint;

      const list = document.createElement('ul');
      list.className = 'items';

      for (const item of items) {
        const li = document.createElement('li');
        const label = document.createElement('label');

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = item.enabled;
        box.addEventListener('change', () => {
          item.enabled = box.checked;
          state.dirty = true;
          count.textContent = `${items.filter((x) => x.enabled).length}/${items.length}`;
          paintSummary();
          status('有未保存的修改');
        });

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.label;

        label.append(box, name);

        if (item.source) {
          const src = document.createElement('span');
          src.className = 'src';
          src.textContent = item.source;
          label.append(src);
        }

        li.append(label);
        list.append(li);
      }

      section.append(head, hint, list);
      host.append(section);
    }
  }

  $('includeOthers').checked = state.includeOthers;
  $('includeOthers').addEventListener('change', (e) => {
    state.includeOthers = e.target.checked;
    state.dirty = true;
    paintSummary();
    status('有未保存的修改');
  });

  $('save').addEventListener('click', async () => {
    const btn = $('save');
    btn.disabled = true;
    status('保存中…');
    try {
      const next = V.toOptions(state.view, { includeOthers: state.includeOthers });
      // 保留用户可能手工加过的其它字段，只覆盖本页面管理的两项。
      const merged = { ...options, ...next };
      const saved = await magpie.options.set(merged);
      options = saved || merged;
      state.dirty = false;
      status('已保存', 'ok');
      paintSummary();
    } catch (error) {
      status('保存失败：' + (error?.message || String(error)), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  paintGroups();
  paintSummary();
})();
