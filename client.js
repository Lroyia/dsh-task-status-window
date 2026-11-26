window.__ModuleLoader__.load({
  id: 'dsh-task-status-window',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    /** 插件在 Loader 里占用的行标识，也是配置表单的命名空间。 */
    const NAMESPACE = 'dsh-task-status-window';
    /** 本插件拥有的文案命名空间。 */
    const NS = 'dsh-task-status-window';
    /** 在插件管理页里的排序。 */
    const ORDER = 40;

    /** 宿主路由（文档相对写法：页面以相对 base 提供）。 */
    const API = {
      theme: 'api/dsh-task-status-window/theme',
      claim: 'api/dsh-task-status-window/focus-claim',
      statuses: 'api/dsh-task-status-window/statuses',
    };

    /**
     * 本页面的标识。
     *
     * 同一个宿主上可能开着桌面窗口和浏览器标签页，各自看到的状态不一样，
     * 宿主按这个 id 分开存、读的时候再合并。
     */
    const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    /**
     * 这个页面跑在桌面端外壳里，还是普通的浏览器标签页。
     *
     * 桌面端用 dsh-app:// 这个自己的协议打开页面，浏览器标签页则是 http(s)。
     * 「切到某个任务」的请求要交给桌面端——只有它才是用户眼前那个主体程序；
     * 标签页多半只是顺带开着，不该把它抢走。
     */
    const CLIENT_KIND = (() => {
      try {
        const protocol = window.location.protocol;
        if (protocol === 'dsh-app:') return 'desktop';
        return 'web';
      } catch {
        return 'web';
      }
    })();

    /** 浮窗面板上显示的文案。 */
    const PANEL_TEXT = {
      title: 'panelTitle',
      empty: 'panelEmpty',
      timeNow: 'timeNow',
      timeMinutes: 'timeMinutes',
      timeHours: 'timeHours',
      timeDays: 'timeDays',
      timeMonths: 'timeMonths',
      timeYears: 'timeYears',
      pendingApproval: 'pendingApproval',
      pendingPlanReview: 'pendingPlanReview',
      pendingAnswer: 'pendingAnswer',
    };

    /** 中文文案。 */
    const zh = {
      title: '任务状态浮窗',
      description: '把运行中、待批准与办结待确认的任务放进一个系统级置顶窗口。',
      windowTitle: '浮窗设置',
      width: '浮窗宽度（像素）',
      widthHint: '浮窗的初始宽度；拖动浮窗改变大小后，这里会同步为当前宽度。宽度不能小于顶部栏放得下的最小值。',
      height: '浮窗高度（像素）',
      heightHint: '浮窗的高度跟着任务多少自动变化，不用设置。',
      left: '左边距（屏幕像素）',
      leftHint: '浮窗左侧到屏幕左边的距离；关掉「自动定位」后生效。',
      top: '上边距（屏幕像素）',
      topHint: '浮窗顶部到屏幕上边的距离；关掉「自动定位」后生效。',
      autoPosition: '自动定位到屏幕右下角',
      autoPositionHint: '打开时浮窗总是落在屏幕右下角；拖动过浮窗后会自动关掉它。',
      poll: '刷新间隔（毫秒）',
      pollHint: '浮窗每隔多久向宿主要一次任务状态。',
      enabled: '显示浮窗',
      enabledHint: '关掉以后浮窗进程会退出，其它设置保持不变。',
      alwaysOnTop: '始终置顶',
      alwaysOnTopHint: '浮窗是否浮在所有窗体最前面。',
      showCompleted: '列出办结待确认的任务',
      showCompletedHint: '关掉以后只显示运行中与等待处理的任务。',
      apply: '应用',
      applying: '应用中…',
      applied: '已应用',
      discard: '放弃改动',
      reset: '恢复默认',
      resetHint: '把所有设置恢复成默认值。',
      invalidNumber: '请填写一个整数。',
      outOfRange: '数值需要在 {min} 到 {max} 之间。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '宿主没有接受这些数值，请检查后重试。',
      panelTitle: '任务状态',
      panelEmpty: '当前没有需要关注的任务',
      timeNow: '刚刚',
      timeMinutes: '{n}分钟',
      timeHours: '{n}小时',
      timeDays: '{n}天',
      timeMonths: '{n}个月',
      timeYears: '{n}年',
      pendingApproval: '待审批',
      pendingPlanReview: '计划待审',
      pendingAnswer: '待回答',
    };

    /** 英文文案。 */
    const en = {
      title: 'Task status window',
      description: 'Keeps running, awaiting-approval and finished tasks in an always-on-top window.',
      windowTitle: 'Panel settings',
      width: 'Panel width (pixels)',
      widthHint: 'The panel starts at this width; resizing the panel updates this value. It cannot be narrower than the header needs.',
      height: 'Panel height (pixels)',
      heightHint: 'The panel height follows the number of tasks, so there is nothing to set.',
      left: 'Left offset (screen pixels)',
      leftHint: 'Distance from the left screen edge; used when auto position is off.',
      top: 'Top offset (screen pixels)',
      topHint: 'Distance from the top screen edge; used when auto position is off.',
      autoPosition: 'Place in the bottom-right corner',
      autoPositionHint: 'While on, the panel always lands in the bottom-right corner; moving the panel turns it off.',
      poll: 'Refresh interval (milliseconds)',
      pollHint: 'How often the panel asks the Host for the task states.',
      enabled: 'Show the panel',
      enabledHint: 'Turning this off closes the panel window and keeps the other settings.',
      alwaysOnTop: 'Always on top',
      alwaysOnTopHint: 'Whether the panel floats above every other window.',
      showCompleted: 'List finished tasks',
      showCompletedHint: 'Turning this off lists only running and awaiting tasks.',
      apply: 'Apply',
      applying: 'Applying…',
      applied: 'Applied',
      discard: 'Discard changes',
      reset: 'Reset to default',
      resetHint: 'Restore every setting to its default value.',
      invalidNumber: 'Enter a whole number.',
      outOfRange: 'The value must be between {min} and {max}.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The Host did not accept these values; check them and try again.',
      panelTitle: 'Task status',
      panelEmpty: 'No task needs attention right now',
      timeNow: 'now',
      timeMinutes: '{n}min',
      timeHours: '{n}h',
      timeDays: '{n}d',
      timeMonths: '{n}mo',
      timeYears: '{n}y',
      pendingApproval: 'Approval',
      pendingPlanReview: 'Plan review',
      pendingAnswer: 'Answer',
    };

    /** 表单里的数值字段。 */
    const NUMBER_FIELDS = [
      { key: 'windowWidth', label: 'width', hint: 'widthHint', min: 240, max: 1600 },
      { key: 'windowX', label: 'left', hint: 'leftHint', min: -20000, max: 20000 },
      { key: 'windowY', label: 'top', hint: 'topHint', min: -20000, max: 20000 },
      { key: 'pollIntervalMs', label: 'poll', hint: 'pollHint', min: 200, max: 10000 },
    ];

    /** 表单里的开关字段。 */
    const TOGGLE_FIELDS = [
      { key: 'enabled', label: 'enabled', hint: 'enabledHint' },
      { key: 'alwaysOnTop', label: 'alwaysOnTop', hint: 'alwaysOnTopHint' },
      { key: 'showCompleted', label: 'showCompleted', hint: 'showCompletedHint' },
      { key: 'windowAutoPosition', label: 'autoPosition', hint: 'autoPositionHint' },
    ];

    /** 表单使用的样式。 */
    const STYLE = `
      .dsh-task-status-window-form { display: flex; flex-direction: column; gap: 14px; }
      .dsh-task-status-window-field { display: flex; flex-direction: column; gap: 4px; }
      .dsh-task-status-window-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
      .dsh-task-status-window-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dsh-task-status-window-input {
        width: 160px; padding: 6px 8px; font: inherit; font-size: 13px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
      }
      .dsh-task-status-window-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); }
      .dsh-task-status-window-actions { display: flex; gap: 8px; align-items: center; }
      .dsh-task-status-window-button {
        padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
      }
      .dsh-task-status-window-button[data-primary='true'] {
        color: var(--dsw-alias-bg-base); background: var(--dsw-alias-brand-primary); border-color: transparent;
      }
      .dsh-task-status-window-button:disabled { opacity: 0.55; cursor: default; }
      .dsh-task-status-window-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
    `;

    /**
     * 把一个颜色解析成 #rrggbb。
     *
     * 主题 token 的值可能是 `color-mrgb(...)`、`color(srgb ...)` 这类表达式，
     * 浮窗的绘图库只认具体的颜色值。这里借一块画布把颜色画出来再读回像素，
     * 这样任何 CSS 颜色写法都能被解析成具体的 rgb 值；半透明的颜色会压在
     * 给定的底色上，得到与界面一致的实际观感。
     * @param {string} color - CSS 颜色文本。
     * @param {string} backdrop - 半透明时压在下面的底色。
     * @returns {string} #rrggbb 形式的颜色，空串表示解析不出来。
     */
    function toHex(color, backdrop) {
      if (typeof color !== 'string' || color.trim() === '') return '';
      const text = color.trim();
      if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
      if (/^#[0-9a-f]{3}$/i.test(text)) {
        return `#${text.slice(1).split('').map((part) => part + part).join('').toLowerCase()}`;
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) return '';
        context.fillStyle = backdrop !== '' ? backdrop : '#ffffff';
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = text;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return `#${[pixel[0], pixel[1], pixel[2]].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
      } catch {
        return '';
      }
    }

    /**
     * 一个颜色的相对亮度。
     * @param {string} hex - #rrggbb 形式的颜色。
     * @returns {number} 0（黑）到 1（白）之间的亮度。
     */
    function luminance(hex) {
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      if (match === null) return 0;
      const channel = (value) => {
        const part = parseInt(value, 16) / 255;
        return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
    }

    /**
     * 读取当前主题的 token 值。
     *
     * 界面上的半透明层是压在页面底色上的，因此这里先把底色解出来，再把每
     * 个 token 压上去，得到与界面观感一致的具体颜色。浮窗必须是完全不透明
     * 的，所以最后再确认一次底色不是「透明」。
     * @returns {Record<string, string>} 浮窗需要的颜色与字体。
     */
    function readThemeTokens() {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;visibility:hidden;';
      document.body.appendChild(probe);
      /**
       * @param {string} name - CSS 变量名。
       * @param {'color'|'background'} kind - 用哪一种属性去解析它。
       * @param {string} backdrop - 半透明时压在下面的底色。
       * @returns {string} 解析后的颜色。
       */
      const resolve = (name, kind, backdrop) => {
        probe.style.color = '';
        probe.style.backgroundColor = '';
        probe.style.setProperty(kind === 'color' ? 'color' : 'background-color', `var(${name})`);
        const computed = getComputedStyle(probe);
        const raw = kind === 'color' ? computed.color : computed.backgroundColor;
        return toHex(raw, backdrop);
      };
      /**
       * @param {string} name - CSS 变量名。
       * @returns {string} 字体族列表。
       */
      const fontStack = (name) => {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name);
        return typeof value === 'string' ? value.trim() : '';
      };
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      // 页面底色：启动时注入的 --dsh-boot-bg 就是它，缺失时按明暗主题补上。
      const boot = toHex(getComputedStyle(document.body).getPropertyValue('--dsh-boot-bg'), '');
      const base = boot !== '' ? boot : dark ? '#151517' : '#ffffff';
      const layer1 = resolve('--dsw-alias-bg-layer-1', 'background', base);
      const layer2 = resolve('--dsw-alias-bg-layer-2', 'background', base);
      const background = layer1 !== '' ? layer1 : base;
      const surface = layer2 !== '' ? layer2 : background;      /**
       * @param {string} name - CSS 变量名。
       * @param {string} fallback - 解析不出来或对比不足时的替代值。
       * @returns {string} 一个在底色上读得清的颜色。
       */
      const readable = (name, fallback) => {
        const value = resolve(name, 'color', background);
        if (value === '') return fallback;
        const contrast = Math.abs(luminance(value) - luminance(background));
        return contrast < 0.2 ? fallback : value;
      };
      // 状态色沿用界面状态点自己的映射：运行中用 tertiary 文字色（界面上
      // 加载动画的颜色），等待处理用 warning，办结用 success。
      const tokens = {
        background,
        surface,
        border: resolve('--dsw-alias-border-l1', 'color', background),
        text: readable('--dsw-alias-label-primary', dark ? '#f5f5f5' : '#0f1115'),
        muted: readable('--dsw-alias-label-tertiary', dark ? '#a1a1a6' : '#6b7280'),
        running: readable('--dsw-alias-label-tertiary', dark ? '#a1a1a6' : '#6b7280'),
        warning: readable('--dsw-alias-state-warn-primary', '#d9822b'),
        success: readable('--dsw-alias-state-success-primary', '#3f9e5a'),
        idle: readable('--dsw-alias-state-idle-primary', dark ? '#6b7280' : '#9aa1ad'),
        font: fontStack('--dsw-font-family'),
      };
      probe.remove();
      return tokens;
    }

    /**
     * 启动一个不受后台标签页节流影响的循环。
     *
     * 浏览器把隐藏页面的定时器降到每分钟一次，而浮窗的聚焦请求必须在主界面
     * 处于后台时也能被领走，因此这里用 MessageChannel 驱动。
     * @param {() => void} callback - 每轮要做的事。
     * @returns {() => void} 停止循环。
     */
    function startUnthrottledLoop(callback) {
      if (typeof MessageChannel !== 'function') {
        const timer = setInterval(callback, 500);
        return () => clearInterval(timer);
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        callback();
        channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
      return () => {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
      };
    }

    /**
     * 插件管理页里的设置卡片。
     * @param {object} props - 槽位给的属性。
     * @returns {React.ReactNode} 卡片。
     */
    function TaskStatusWindowCard(props) {
      const { t } = props;
      const form = props.formController;
      const [snapshot, setSnapshot] = useState(() => (form ? form.getSnapshot() : undefined));
      const [draft, setDraft] = useState(() => ({}));
      const [state, setState] = useState('idle');
      const [error, setError] = useState('');

      useEffect(() => {
        if (!form) return undefined;
        const dispose = form.subscribe(() => setSnapshot(form.getSnapshot()));
        setSnapshot(form.getSnapshot());
        return dispose;
      }, [form]);

      const value = useMemo(() => (snapshot && snapshot.value) || {}, [snapshot]);

      if (props.view === 'summary') {
        return h('span', { className: 'dsh-task-status-window-summary' }, t('description'));
      }

      if (!form) {
        return h('div', { className: 'dsh-task-status-window-form' },
          h('p', { className: 'dsh-task-status-window-hint' }, t('unavailable')));
      }
      if (snapshot && snapshot.status === 'unavailable') {
        return h('div', { className: 'dsh-task-status-window-form' },
          h('p', { className: 'dsh-task-status-window-hint' }, t('unavailable')));
      }

      const writable = snapshot ? snapshot.writable !== false : false;
      const current = (key) => (draft[key] !== undefined ? draft[key] : value[key]);

      /**
       * @param {string} key - 字段名。
       * @param {string} raw - 输入框里的文本。
       */
      const editNumber = (key, raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          setError(t('invalidNumber'));
          return;
        }
        const spec = NUMBER_FIELDS.find((field) => field.key === key);
        if (spec !== undefined && (parsed < spec.min || parsed > spec.max)) {
          setError(t('outOfRange', { min: spec.min, max: spec.max }));
          return;
        }
        setError('');
        setDraft((previous) => ({ ...previous, [key]: Math.round(parsed) }));
      };

      /**
       * @param {string} key - 字段名。
       * @param {boolean} next - 新的开关值。
       */
      const editToggle = (key, next) => {
        setError('');
        setDraft((previous) => ({ ...previous, [key]: next }));
      };

      /** 把暂存的值写进宿主。 */
      const apply = async () => {
        const entries = Object.entries(draft);
        if (entries.length === 0) return;
        setState('saving');
        setError('');
        try {
          let accepted = true;
          for (const [key, next] of entries) {
            // eslint-disable-next-line no-await-in-loop
            const ok = await form.set(key, next);
            accepted = accepted && ok;
          }
          if (accepted) {
            setDraft({});
            setState('applied');
          } else {
            setState('idle');
            setError(t('saveFailed'));
          }
        } catch {
          setState('idle');
          setError(t('saveFailed'));
        }
      };

      /** 放弃尚未应用的改动。 */
      const discard = () => {
        setDraft({});
        setError('');
        setState('idle');
      };

      /** 把所有字段恢复成默认值。 */
      const reset = async () => {
        setState('saving');
        setError('');
        const keys = [...NUMBER_FIELDS.map((field) => field.key), ...TOGGLE_FIELDS.map((field) => field.key)];
        try {
          let accepted = true;
          for (const key of keys) {
            // eslint-disable-next-line no-await-in-loop
            const ok = await form.unset(key);
            accepted = accepted && ok;
          }
          if (accepted) {
            setDraft({});
            setState('idle');
          } else {
            setState('idle');
            setError(t('saveFailed'));
          }
        } catch {
          setState('idle');
          setError(t('saveFailed'));
        }
      };

      const dirty = Object.keys(draft).length > 0;
      const overridden = Object.keys(value).length > 0;

      return h('div', { className: 'dsh-task-status-window-form' },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE } }),
        h('h4', { className: 'dsh-task-status-window-label' }, t('windowTitle')),
        ...NUMBER_FIELDS.map((field) => h('label', { key: field.key, className: 'dsh-task-status-window-field' },
          h('span', { className: 'dsh-task-status-window-label' }, t(field.label)),
          h('input', {
            className: 'dsh-task-status-window-input',
            type: 'number',
            min: field.min,
            max: field.max,
            step: 1,
            disabled: !writable,
            value: current(field.key) === undefined ? '' : String(current(field.key)),
            onChange: (event) => editNumber(field.key, event.target.value),
          }),
          h('span', { className: 'dsh-task-status-window-hint' }, t(field.hint)),
        )),
        ...TOGGLE_FIELDS.map((field) => h('label', { key: field.key, className: 'dsh-task-status-window-field' },
          h('span', { className: 'dsh-task-status-window-toggle' },
            h('input', {
              type: 'checkbox',
              disabled: !writable,
              checked: current(field.key) !== false,
              onChange: (event) => editToggle(field.key, event.target.checked),
            }),
            t(field.label),
          ),
          h('span', { className: 'dsh-task-status-window-hint' }, t(field.hint)),
        )),
        error !== '' ? h('p', { className: 'dsh-task-status-window-error' }, error) : null,
        writable ? null : h('p', { className: 'dsh-task-status-window-hint' }, t('readOnly')),
        h('div', { className: 'dsh-task-status-window-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-task-status-window-button',
            'data-primary': 'true',
            disabled: !writable || !dirty || state === 'saving',
            onClick: () => { void apply(); },
          }, state === 'saving' ? t('applying') : t('apply')),
          h('button', {
            type: 'button',
            className: 'dsh-task-status-window-button',
            disabled: !writable || !dirty,
            onClick: discard,
          }, t('discard')),
          h('button', {
            type: 'button',
            className: 'dsh-task-status-window-button',
            disabled: !writable || (!dirty && !overridden),
            onClick: () => { void reset(); },
          }, t('reset')),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-status-window: dictionaries');
        const t = ctx.locale.bind(NS);

        // 表单控制器由插件自己持有，卡片与它共享同一个实例。
        let formController = undefined;
        const card = (props) => TaskStatusWindowCard({ ...props, formController });

        // 配置命名空间是宿主给插件条目分配的 id。插件从 bundle 安装时，条目
        // 落在 include 层里，因此 id 形如 `include:<bundle>`；直接装在配置档
        // 里的插件则用条目自己的 id。两种都试一下，宿主供哪一个就用哪个。
        ctx.effect(() => ctx.configForms.whileServed(
          [NAMESPACE, `include:${NAMESPACE}`],
          (served) => {
            const namespace = served.has(NAMESPACE) ? NAMESPACE : `include:${NAMESPACE}`;
            return ctx.slots.inject('plugins.item', () => {
              formController = ctx.configForms.get(namespace);
              return ctx.slots.register({
                name: 'plugins.item', id: NAMESPACE, order: ORDER, label: () => t('title'), locale: NS,
              }, card);
            });
          },
        ), 'task-status-window: settings page');

        // 把当前主题与文案回传给浮窗进程。
        const publishTheme = () => {
          const labels = {};
          for (const [key, name] of Object.entries(PANEL_TEXT)) labels[key] = t(name);
          return fetch(API.theme, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tokens: readThemeTokens(), labels }),
          }).catch(() => { /* 宿主不在时忽略 */ });
        };
        ctx.effect(() => {
          const publish = () => { void publishTheme(); };
          publish();
          const observer = new MutationObserver(publish);
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'style', 'data-ds-dark-theme'] });
          return () => observer.disconnect();
        }, 'task-status-window: theme bridge');

        // 把界面自己的会话状态事实回传给宿主。
        //
        // 侧栏的黄点、绿点就是这份事实（运行中 / 等待用户处理 / 办结未读），
        // 浮窗照搬它才和侧栏完全一致 —— 尤其是本插件启动之前就已经在等待的
        // 审批请求：那种请求的事件早就发过去了，宿主事后补听是听不到的。
        ctx.effect(() => {
          let lastAt = 0;
          /** 上一次报上去的、需要出现在浮窗里的会话。 */
          let reported = new Set();
          const stop = startUnthrottledLoop(() => {
            // 这个循环是刻意不被后台节流的，所以要自己限速。
            const now = Date.now();
            if (now - lastAt < 2000) return;
            lastAt = now;
            const uiSession = ctx.get('uiSession');
            if (!uiSession || !uiSession.sessionStatus) return;
            const snapshot = uiSession.sessionStatus.getSnapshot();
            const statuses = [];
            const current = new Set();
            snapshot.forEach((status, sessionId) => {
              if (!status) return;
              const pending = status.pendingInteraction;
              const pendingKind = pending && typeof pending.kind === 'string' ? pending.kind : undefined;
              // 只回传需要出现在浮窗里的会话，省得把整张表都搬过去。
              if (pendingKind === undefined && status.running !== true && status.completionUnread !== true) return;
              const id = String(sessionId);
              current.add(id);
              statuses.push({
                id,
                running: status.running === true,
                pendingKind,
                unread: status.completionUnread === true,
              });
            });
            // 刚才还亮着、现在不亮了 —— 明确告诉宿主一声。
            //
            // 界面的「办结未读」是在主窗口里把这个会话读掉之后才消失的。不
            // 说的话，宿主只知道它「曾经亮过」，浮窗上的绿点就永远消不掉。
            const cleared = [...reported].filter((id) => !current.has(id));
            reported = current;
            const body = JSON.stringify({
              clientId: CLIENT_ID,
              kind: CLIENT_KIND,
              statuses,
              cleared,
            });
            // 每次都发：宿主用「多久没收到」判断这份状态还新不新鲜，只在变化
            // 时才发会让它在几分钟后过期。
            void fetch(API.statuses, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            }).catch(() => { /* 宿主不在时忽略 */ });
          });
          return stop;
        }, 'task-status-window: session status bridge');

        // 领取浮窗发来的「切到某个任务」请求。
        ctx.effect(() => {
          let last = 0;
          const stop = startUnthrottledLoop(() => {
            const now = Date.now();
            if (now - last < 400) return;
            last = now;
            void fetch(API.claim, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: CLIENT_KIND }),
            })
              .then((response) => (response.ok ? response.json() : undefined))
              .then((payload) => {
                if (payload && payload.themeReceived === false) {
                  // 宿主重启后丢了主题，浮窗会退回兜底色板；重发一次即可。
                  void publishTheme();
                  return;
                }
                const sessionId = payload && payload.focus ? payload.focus.sessionId : undefined;
                if (typeof sessionId !== 'string' || sessionId === '') return;
                const workspace = ctx.get('uiWorkspace');
                if (workspace) workspace.openSession(sessionId);
              })
              .catch(() => { /* 宿主不在时忽略 */ });
          });
          return stop;
        }, 'task-status-window: focus bridge');
      },
    };
  },
});
