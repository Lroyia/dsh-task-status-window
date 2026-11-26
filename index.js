/**
 * 任务状态浮窗 —— Host half.
 *
 * 这个插件把 DeepSeek Harness 工作区里的三类任务状态（运行中的加载动画、
 * 待批准的黄点、办结待确认的绿点）搬到一个系统级置顶窗口里，让用户在切到
 * 其它应用时也能一眼看到任务进展，并点回对应的任务页面。
 *
 * Host 半侧负责四件事：
 *
 *  1. 从运行时的真实事实派生任务清单（Agent 的运行状态、审批与提问的等待、
 *     以及刚刚跑完还没确认的会话）；
 *  2. 在宿主自带的 web server 上注册插件自己的路由族 —— 浏览器半侧（插件
 *     管理页里的数值设置、主题色板回传、聚焦请求领取）与浮窗进程共用这一族；
 *  3. 拉起并看护真正的系统级置顶浮窗进程（native/panel.py），它由 Python +
 *     Tk 绘制，因此不依赖 Electron；
 *  4. 把浮窗最后一次调整的大小与位置写回插件配置，下次启动按同样的尺寸恢复。
 *
 * 路由族带信任边界：只有本机回环请求能进入，而且浮窗进程还必须带上本次
 * 启动随机生成的令牌；浏览器半侧的请求必须来自 Harness 自己的页面。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * 找到 schemastery。
 *
 * 插件从本地目录安装时，宿主把它链接到插件目录，于是裸包名要沿着插件目录
 * 往上找，而不是沿着配置档目录找。因此这里依次尝试几个解析基准：插件自身
 * 所在的位置、配置档目录、以及 DeepSeek Harness 安装目录里的 node_modules。
 * @returns {any} schemastery 的 z。
 */
function loadSchemastery() {
  /** @type {string[]} */
  const bases = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') bases.push(join(profileDir, 'package.json'));
  bases.push(fileURLToPath(import.meta.url));
  bases.push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', 'package.json'));
  for (const base of bases) {
    try {
      const require = createRequire(base);
      require.resolve('@deepseek-ai/schemastery');
      return require('@deepseek-ai/schemastery');
    } catch {
      /* 换下一个基准 */
    }
  }
  throw new Error('dsh-task-status-window: @deepseek-ai/schemastery could not be resolved');
}

const z = loadSchemastery();

/** 插件包目录（本文件所在目录）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 浮窗进程脚本。 */
const PANEL_SCRIPT = join(HERE, 'native', 'panel.py')

/** 插件自己的路由族。浏览器半侧使用不带前导斜杠的同源写法。 */
export const ROUTES = {
  /** 浮窗读取任务清单、主题色板与窗口几何。 */
  state: '/api/dsh-task-status-window/state',
  /** 浮窗回报最后一次调整的窗口大小与位置。 */
  geometry: '/api/dsh-task-status-window/geometry',
  /** 浮窗请求把某个任务切到前台。 */
  focus: '/api/dsh-task-status-window/focus',
  /** 浮窗请求置顶或取消置顶。 */
  topmost: '/api/dsh-task-status-window/topmost',
  /** 浮窗请求关闭自己。 */
  close: '/api/dsh-task-status-window/close',
  /** 浏览器半侧回传各会话的状态事实（与侧栏用的是同一份）。 */
  statuses: '/api/dsh-task-status-window/statuses',
  /** 浏览器半侧回传当前主题色板。 */
  theme: '/api/dsh-task-status-window/theme',
  /** 浏览器半侧领取一次「切到某个任务」的请求。 */
  claim: '/api/dsh-task-status-window/focus-claim',
}

/** 浏览器半侧使用的文档相对路径（页面以相对 base 提供）。 */
export const CLIENT_ROUTES = {
  state: 'api/dsh-task-status-window/state',
  theme: 'api/dsh-task-status-window/theme',
  claim: 'api/dsh-task-status-window/focus-claim',
  focus: 'api/dsh-task-status-window/focus',
  statuses: 'api/dsh-task-status-window/statuses',
}

/** 浮窗进程带上令牌时使用的请求头。 */
const TOKEN_HEADER = 'x-dsh-task-window-token'

/** 一次请求体允许的最大字节数。 */
const MAX_BODY_BYTES = 64 * 1024

/** 浮窗进程退出后重新拉起的等待时间（毫秒）。 */
const PANEL_RESTART_DELAY_MS = 1500

/** 浮窗进程与配置对齐的检查间隔（毫秒）。 */
const PANEL_RECONCILE_INTERVAL_MS = 2000

/** 窗口几何写入配置的合并窗口（毫秒）。 */
const GEOMETRY_WRITE_DELAY_MS = 800

/**
 * 浏览器半侧回传的会话状态多久算过期（毫秒）。
 *
 * 页面关掉之后最后一份状态会一直留着，超过这个时间就不再采信，退回插件自己
 * 从运行时事件里推出来的结果。
 */
const CLIENT_STATUS_TTL_MS = 10000

/** 插件配置里由插件自己管理的字段。 */
const CONFIG_KEYS = [
  'enabled',
  'alwaysOnTop',
  'windowWidth',
  'windowHeight',
  'windowX',
  'windowY',
  'windowAutoPosition',
  'pollIntervalMs',
  'showCompleted',
]

/** 任务清单里最多保留多少条任务。 */
const MAX_TASKS = 50;

/**
 * 「切到某个任务」的请求多久没人领就作废（毫秒）。
 *
 * 桌面端退出后可能还留着半路发出的请求；过这么久还没人领，就当它作废了，
 * 免得半夜突然跳到某个任务上去。
 */
const FOCUS_TTL_MS = 15000

/** 任务标题的最长字符数。 */
const MAX_TITLE_LENGTH = 120

/**
 * 本插件在宿主侧需要的服务。web server 是路由族的载体，因此没有它时整个
 * 插件保持未激活，而不是抛错。connection 是宿主自己的信任栅栏：浏览器半侧
 * 的路由一律先问它「这个请求算不算 Harness 自己发出来的」。
 */
export const inject = ['webServer', 'connection']

/**
 * 插件配置。
 *
 * 全部字段都是 volatile：改动它们就地生效，不会重启插件，也不会打断正在
 * 运行的浮窗进程。用户可以在插件管理页直接改这些数值，拖动浮窗时插件也会
 * 把新的几何写回同一组字段。
 */
export const Config = z.object({
  /** 是否显示浮窗。关闭后浮窗进程退出，插件的其它能力保持可用。 */
  enabled: z.boolean().default(true).volatile(),
  /** 浮窗是否始终置顶。 */
  alwaysOnTop: z.boolean().default(true).volatile(),
  /** 浮窗宽度（像素）。 */
  windowWidth: z.number().min(240).max(1600).default(360).volatile(),
  /**
   * 浮窗高度（像素）。
   *
   * 列表的高度跟着任务多少走，这个字段只留着兼容旧配置，不再参与计算。
   */
  windowHeight: z.number().min(180).max(2000).default(460).volatile(),
  /** 浮窗左边距（屏幕像素）。 */
  windowX: z.number().min(-20000).max(20000).default(-1).volatile(),
  /** 浮窗上边距（屏幕像素）。 */
  windowY: z.number().min(-20000).max(20000).default(-1).volatile(),
  /**
   * 是否把浮窗放在屏幕右下角。
   *
   * 打开时浮窗落在虚拟屏幕的右下角；用户一旦拖动或缩放过浮窗，这个开关就
   * 被关掉，浮窗改用 windowX / windowY 记下的位置。
   */
  windowAutoPosition: z.boolean().default(true).volatile(),
  /** 浮窗刷新任务清单的间隔（毫秒）。 */
  pollIntervalMs: z.number().min(200).max(10000).default(800).volatile(),
  /** 是否列出「办结待确认」的绿点任务。 */
  showCompleted: z.boolean().default(true).volatile(),
})

/**
 * 读取一个配置字段。
 *
 * volatile 字段通过 `get()` 取当前值，普通字段直接就是值；两种写法都要支持，
 * 以免插件被旧版本配置接住时读不到数值。
 * @param {Record<string, unknown>|undefined} config - 插件配置。
 * @param {string} key - 字段名。
 * @param {number|boolean} fallback - 字段缺失时的默认值。
 * @returns {number|boolean} 字段的当前值。
 */
function readField(config, key, fallback) {
  const field = config?.[key];
  if (field === undefined || field === null) return fallback;
  if (typeof field === 'object' && typeof (/** @type {{ get?: unknown }} */ (field).get) === 'function') {
    try {
      const value = /** @type {{ get: () => unknown }} */ (field).get();
      return value === undefined || value === null ? fallback : /** @type {number|boolean} */ (value);
    } catch {
      return fallback;
    }
  }
  return typeof field === 'number' || typeof field === 'boolean' ? field : fallback;
}

/**
 * 是否是回环地址。
 * @param {string|undefined} address - 套接字地址。
 * @returns {boolean} true 表示 127/8 或 ::1。
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  return match[1] === '127' && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * 请求是否来自本机，且没有被代理转发。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} true 表示请求来自本机。
 */
function isLocalRequest(req) {
  const headers = req.headers ?? {};
  if (headers['cf-connecting-ip'] !== undefined) return false;
  if (headers['x-forwarded-for'] !== undefined) return false;
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return isLoopbackAddress(hostUrl.hostname) || hostUrl.hostname.toLowerCase() === 'localhost';
}
/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - 载荷。
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * 读取一个有界的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<object|null>} 解析后的对象，或 null。
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 把一个标题压到单行并截断。
 * @param {string|undefined} title - 原始标题。
 * @returns {string} 可显示的标题。
 */
function tidyTitle(title) {
  if (typeof title !== 'string') return '';
  const flattened = title.replace(/\s+/gu, ' ').trim();
  return flattened.length > MAX_TITLE_LENGTH ? `${flattened.slice(0, MAX_TITLE_LENGTH - 1)}…` : flattened;
}

/**
 * 主题色板的兜底值。
 *
 * 浏览器半侧启动后会把真实的主题 token 传回来；在此之前浮窗先用这组与
 * DeepSeek Harness 浅色/深色主题接近的值渲染。
 */
const FALLBACK_THEME = {
  surface: '#f7f8fa',
  background: '#ffffff',
  border: '#e3e5ea',
  text: '#0f1115',
  muted: '#6b7280',
  running: '#6b7280',
  warning: '#d9822b',
  success: '#3f9e5a',
  idle: '#9aa1ad',
  font: 'Segoe UI',
};

/**
 * 浮窗文案的兜底值。
 *
 * 浏览器半侧启动后会把当前语言的文案传回来，浮窗因此与主界面使用同一种
 * 语言。
 */
const FALLBACK_LABELS = {
  title: '任务状态',
  running: '运行中',
  warning: '等待处理',
  done: '办结待确认',
  empty: '当前没有需要关注的任务',
  hint: '拖动标题栏移动 · 拖右下角改变大小',
};

/**
 * 任务状态浮窗的 Host 运行时。
 *
 * 它持有任务清单的事实来源、主题色板、待领取的聚焦请求，以及浮窗进程的
 * 生命周期。
 */
class TaskStatusWindowRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
   * @param {Record<string, unknown>} config - 插件配置。
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** 本次启动的浮窗令牌。 */
    this.token = randomBytes(24).toString('hex');
    /** 正在运行的会话。 */
    this.running = new Set();
    /** 正在等待用户的会话，值是等待的种类。 */
    this.pending = new Map();
    /** 刚刚跑完、还没确认的会话。 */
    this.completed = new Set();
    /** 每个任务进入当前状态的时刻，用来算浮窗上的计时。 */
    this.since = new Map();
    /**
     * 浏览器半侧回传的会话状态，按页面分开保存。
     *
     * 界面侧栏的黄点、绿点就是从这份事实来的（运行中 / 等待用户处理 / 办结
     * 未读），因此浮窗优先用它。同一个宿主上可能同时开着桌面窗口与浏览器
     * 标签页，各自看到的等待状态并不一样（审批请求只会被其中一个接住），
     * 所以按页面分开存、读的时候合并，而不是后来者覆盖前者。
     */
    this.clients = new Map();
    /** 浏览器半侧回传的主题色板。 */
    this.theme = { ...FALLBACK_THEME };
    /** 浏览器半侧回传的浮窗文案。 */
    this.labels = { ...FALLBACK_LABELS };
    /** 待领取的「切到某个任务」请求。 */
    this.pendingFocus = undefined;
    /** 浮窗进程。 */
    this.panel = undefined;
    /** 浮窗进程的代数：每一代只有一个进程活着。 */
    this.panelGeneration = 0;
    /** 浮窗进程的重启计时器。 */
    this.panelTimer = undefined;
    /** 浮窗进程是否应当存在。 */
    this.panelWanted = false;
    /** 几何写入配置的计时器。 */
    this.geometryTimer = undefined;
    /** 最近一次收到的几何。 */
    this.lastGeometry = undefined;
    /** 已经跑着的浮窗进程使用的几何。 */
    this.appliedGeometry = undefined;
    /** 是否已经收到过浏览器半侧的主题。 */
    this.themeReceived = false;
    /** 是否已经说明过「当前不是桌面版」。 */
    this.desktopReported = false;
  }

  /**
   * 记录一条日志。
   * @param {string} message - 日志内容。
   * @param {boolean} warn - 是否按警告输出。
   */
  log(message, warn = false) {
    const logger = this.ctx.logger;
    if (warn) logger?.warn?.(`[task-status-window] ${message}`);
    else logger?.info?.(`[task-status-window] ${message}`);
  }

  /**
   * 读取当前的窗口几何。
   * @returns {{x: number, y: number, width: number}} 窗口几何。
   */
  geometry() {
    const width = readField(this.config, 'windowWidth', 360);
    const x = readField(this.config, 'windowX', -1);
    const y = readField(this.config, 'windowY', -1);
    const auto = readField(this.config, 'windowAutoPosition', true) !== false;
    return {
      width: typeof width === 'number' ? width : 360,
      x: auto ? -1 : (typeof x === 'number' ? x : -1),
      y: auto ? -1 : (typeof y === 'number' ? y : -1),
    };
  }

  /**
   * 把新的几何写回插件配置。
   *
   * 写回的是同一组 volatile 字段，因此用户在插件管理页看到的数值就是浮窗
   * 此刻的尺寸；下次启动浮窗也会按这组数值恢复。
   * @param {{x: number, y: number, width: number, height: number}} geometry - 新的几何。
   */
  scheduleGeometryWrite(geometry) {
    this.lastGeometry = geometry;
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = undefined;
      void this.writeGeometry(geometry);
    }, GEOMETRY_WRITE_DELAY_MS);
    this.geometryTimer.unref?.();
  }

  /**
   * 把若干字段写进插件配置。
   * @param {Record<string, unknown>} fields - 要写入的字段。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  async writeConfig(fields) {
    const entry = this.ctx.fiber?.entry;
    const editor = this.ctx.get('configEditor');
    if (entry === undefined || editor === undefined) {
      this.log('配置编辑器不可用，本次改动不会被记住', true);
      return false;
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...fields }));
      return true;
    } catch (error) {
      this.log(`配置写入失败：${error instanceof Error ? error.message : String(error)}`, true);
      return false;
    }
  }

  /**
   * 把几何写进插件配置。
   * @param {{x: number, y: number, width: number}} geometry - 新的几何。
   * @returns {Promise<void>} 写入完成。
   */
  async writeGeometry(geometry) {
    const width = Math.round(geometry.width);
    const x = Math.round(geometry.x);
    const y = Math.round(geometry.y);
    const written = await this.writeConfig({
      windowWidth: width,
      windowX: x,
      windowY: y,
      windowAutoPosition: false,
    });
    if (!written) return;
    // 写回的几何就是浮窗此刻的样子，记下来，免得配置对照把这次改动当成
    // 「设置变了」而重启浮窗——那样用户刚拖完，窗口却又闪一下。
    this.appliedGeometry = { width, x, y };
  }

  /**
   * 合并各页面回传的会话状态。
   *
   * 同一个宿主上可能同时开着桌面窗口与浏览器标签页。两者看到的并不总是
   * 一样：审批请求只会被其中一个接住，所以「等待用户处理」是谁报就算谁的；
   * 而「运行中」「办结未读」是两边共知的事实，取最新的一份就好 —— 否则
   * 一个落后了的页面会把已经消掉的状态一直吊着。
   * @returns {Map<string, {running: boolean, pendingKind?: string, unread: boolean}>} 合并后的状态。
   */
  clientFacts() {
    const now = Date.now();
    /** @type {Map<string, {at: number, running: boolean, unread: boolean}>} */
    const merged = new Map();
    /** @type {Map<string, {at: number, kind: string}>} */
    const pendings = new Map();
    for (const entry of this.clients.values()) {
      if (now - entry.at >= CLIENT_STATUS_TTL_MS) continue;
      for (const [id, record] of entry.records) {
        const previous = merged.get(id);
        if (previous === undefined || entry.at >= previous.at) {
          merged.set(id, {
            at: entry.at,
            running: record.running,
            unread: record.unread,
          });
        }
      }
      for (const [id, kind] of entry.pending) {
        const previous = pendings.get(id);
        if (previous === undefined || entry.at >= previous.at) {
          pendings.set(id, { at: entry.at, kind });
        }
      }
    }
    /** @type {Map<string, {running: boolean, pendingKind?: string, unread: boolean}>} */
    const result = new Map();
    for (const [id, record] of merged) {
      const pending = pendings.get(id);
      result.set(id, {
        running: record.running,
        unread: record.unread,
        pendingKind: pending?.kind,
      });
    }
    // 只有「等待用户处理」的会话不一定出现在上面那批记录里，单独补回去。
    for (const [id, pending] of pendings) {
      if (result.has(id)) continue;
      result.set(id, { running: false, unread: false, pendingKind: pending.kind });
    }
    return result;
  }

  /**
   * 采集当前的任务清单。
   * @returns {Array<{id: string, title: string, state: string, detail: string, since: number}>} 任务清单。
   */
  tasks() {
    const showCompleted = readField(this.config, 'showCompleted', true) !== false;
    const sessions = this.ctx.get('sessions');
    const titles = this.ctx.get('sessionTitle');
    /** @type {Map<string, {id: string, title: string, state: string, detail: string, since: number}>} */
    const collected = new Map();
    const facts = this.clientFacts();
    const ids = new Set([
      ...facts.keys(),
      ...this.running,
      ...this.pending.keys(),
      ...this.completed,
    ]);
    const now = Date.now();
    /** @type {Map<string, {state: string, since: number}>} */
    const seen = new Map();
    for (const id of ids) {
      const key = String(id);
      const fact = facts.get(key);
      const pendingKind = this.pending.get(id);
      /** @type {'running'|'warning'|'done'} */
      let state;
      /** @type {string|undefined} */
      let kind;
      /** @type {string} */
      let detail;
      if (fact !== undefined) {
        // 界面给的事实优先：它和侧栏的黄点/绿点是同一份。
        if (fact.pendingKind !== undefined) {
          state = 'warning';
          kind = fact.pendingKind;
          detail = kind === 'approval'
            ? '等待批准'
            : kind === 'plan-review'
              ? '计划待审'
              : '等待回答';
        } else if (fact.running) {
          state = 'running';
          detail = '运行中';
        } else if (fact.unread) {
          state = 'done';
          detail = '办结待确认';
        } else {
          continue;
        }
      } else if (pendingKind !== undefined) {
        state = 'warning';
        kind = pendingKind;
        detail = pendingKind === 'approval'
          ? '等待批准'
          : pendingKind === 'plan-review'
            ? '计划待审'
            : '等待回答';
      } else if (this.running.has(id)) {
        state = 'running';
        detail = '运行中';
      } else if (this.completed.has(id)) {
        state = 'done';
        detail = '办结待确认';
      } else {
        continue;
      }
      // 计时：任务进入当前状态的时刻。状态没变就沿用旧的时间，这样浮窗上的
      // 计时是连续走的，不会因为每次采集而重置。
      const previous = this.since.get(key);
      const since = previous !== undefined && previous.state === state ? previous.since : now;
      seen.set(key, { state, since });
      const session = sessions?.get?.(id);
      const snapshot = session === undefined ? undefined : titles?.get?.(session);
      const title = tidyTitle(snapshot?.title) || String(id);
      collected.set(id, {
        id: key,
        title,
        state,
        detail,
        since,
        pendingKind: state === 'warning' ? (kind ?? 'question') : undefined,
      });
    }
    this.since = seen;
    const ordered = [...collected.values()].filter((task) => showCompleted || task.state !== 'done');
    const rank = { warning: 0, running: 1, done: 2 };
    ordered.sort((left, right) => (rank[left.state] ?? 3) - (rank[right.state] ?? 3));
    return ordered.slice(0, MAX_TASKS);
  }

  /**
   * 读出插件配置的分层情况。
   *
   * 配置一共三层：继承层（profile 之外的东西）、用户层（profile patch 里
   * 显式写下的值）与最终生效的值。排查「设置改了却不生效」时需要看清这三
   * 层分别是什么，因此把它们一起报出来。
   * @returns {{effective: Record<string, unknown>, inherited: Record<string, unknown>, override: Record<string, unknown>}} 分层情况。
   */
  configLayers() {
    const entry = this.ctx.fiber?.entry;
    const editor = this.ctx.get('configEditor');
    const effective = {};
    for (const key of CONFIG_KEYS) {
      effective[key] = readField(this.config, key, undefined);
    }
    if (entry === undefined || editor === undefined) {
      return { effective, inherited: {}, override: {} };
    }
    try {
      const row = editor.configuration().find((item) => item.entry.options.id === entry.options.id);
      return {
        effective,
        inherited: row?.inherited ?? {},
        override: row?.override ?? {},
      };
    } catch (error) {
      this.log(`读取配置分层失败：${error instanceof Error ? error.message : String(error)}`, true);
      return { effective, inherited: {}, override: {} };
    }
  }

  /**
   * 组装浮窗要读取的状态。
   * @returns {object} 状态载荷。
   */
  state() {
    return {
      tasks: this.tasks(),
      theme: this.theme,
      labels: this.labels,
      geometry: this.geometry(),
      alwaysOnTop: readField(this.config, 'alwaysOnTop', true) !== false,
      autoPosition: readField(this.config, 'windowAutoPosition', true) !== false,
      pollIntervalMs: readField(this.config, 'pollIntervalMs', 800),
      config: this.configLayers(),
    };
  }

  /**
   * 记住一条「切到某个任务」的请求。
   * @param {string} sessionId - 会话标识。
   */
  requestFocus(sessionId) {
    this.pendingFocus = { sessionId, at: Date.now() };
    this.completed.delete(sessionId);
  }

  /**
   * 领取一次「切到某个任务」的请求。
   *
   * 请求只交给该交的那个页面：桌面端在场时只给桌面端，否则给任何一个页面。
   * 桌面端把请求带过去才能真正在主体程序里打开这个任务；浏览器标签页多半
   * 只是顺带开着，不该把它抢走。
   * @param {string} kind - 领取者所在的外壳（desktop 或 web）。
   * @returns {{sessionId: string}|null} 待处理的请求。
   */
  claimFocus(kind) {
    const pending = this.pendingFocus;
    if (pending === undefined) return null;
    // 太久没人领的请求作废：免得桌面端早就关掉了，旧请求却在半夜跳出来。
    if (Date.now() - pending.at >= FOCUS_TTL_MS) {
      this.pendingFocus = undefined;
      return null;
    }
    if (kind !== 'desktop' && this.hasLiveDesktopClient()) return null;
    this.pendingFocus = undefined;
    return { sessionId: pending.sessionId };
  }

  /**
   * 桌面上是否还有一个活着的客户端。
   *
   * 「活着」以最近一次上报为准：桌面端退出后不再上报，过一会儿就当它不在。
   * @returns {boolean} true 表示桌面端此刻在场。
   */
  hasLiveDesktopClient() {
    const now = Date.now();
    for (const entry of this.clients.values()) {
      if (entry.kind !== 'desktop') continue;
      if (now - entry.at < CLIENT_STATUS_TTL_MS) return true;
    }
    return false;
  }

  /**
   * 记录浏览器半侧回传的主题色板与文案。
   * @param {Record<string, unknown>} payload - 主题 token 与文案。
   */
  applyTheme(payload) {
    if (typeof payload !== 'object' || payload === null) return;
    const tokens = payload.tokens;
    if (typeof tokens === 'object' && tokens !== null) {
      /** @type {Record<string, string>} */
      const next = { ...this.theme };
      for (const [key, value] of Object.entries(tokens)) {
        if (typeof value === 'string') next[key] = value;
      }
      this.theme = next;
    }
    const labels = payload.labels;
    if (typeof labels === 'object' && labels !== null) {
      /** @type {Record<string, string>} */
      const next = { ...this.labels };
      for (const [key, value] of Object.entries(labels)) {
        if (typeof value === 'string') next[key] = value;
      }
      this.labels = next;
    }
    this.themeReceived = true;
  }

  /**
   * 找到可用的 Python 解释器。
   *
   * DeepSeek Harness 自带的运行时里有带 Tk 的 Python；找不到时回落到 PATH 上
   * 的 python。
   * @returns {string|undefined} 解释器路径。
   */
  findPython() {
    /** @type {string[]} */
    const candidates = [];
    if (typeof process.env.DSH_PYTHON === 'string' && process.env.DSH_PYTHON !== '') {
      candidates.push(process.env.DSH_PYTHON);
    }
    const runtimeRoot = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python');
    if (process.platform === 'win32') candidates.push(join(runtimeRoot, 'python.exe'));
    else candidates.push(join(runtimeRoot, 'bin', 'python3'));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * 这个插件是不是跑在桌面外壳里。
   *
   * 浮窗是系统级的置顶窗口，只有桌面版才有外壳可依附；web 版没有桌面进程，
   * 因此插件在那里不做任何事，只在宿主日志里说明一次。
   * @returns {boolean} true 表示当前是桌面版。
   */
  isDesktop() {
    const versions = process.versions;
    return typeof versions?.electron === 'string' && versions.electron !== '';
  }

  /**
   * 拉起浮窗进程。
   */
  startPanel() {
    if (!this.panelWanted) return;
    if (this.panel !== undefined) return;
    if (!this.isDesktop()) {
      // web 版本没有桌面外壳，系统级置顶窗口做不了；这里明确说明一次，
      // 之后不再尝试。
      if (!this.desktopReported) {
        this.desktopReported = true;
        this.log('任务状态浮窗只在 DeepSeek Harness 桌面版上可用，当前运行环境没有桌面外壳', true);
      }
      return;
    }
    if (!existsSync(PANEL_SCRIPT)) {
      this.log(`找不到浮窗脚本：${PANEL_SCRIPT}`, true);
      return;
    }
    const python = this.findPython();
    if (python === undefined) {
      this.log('未找到带 Tk 的 Python，浮窗无法启动；请安装 Python 3 或设置 DSH_PYTHON', true);
      return;
    }
    const geometry = this.geometry();
    this.appliedGeometry = geometry;
    const origin = this.ctx.get('webServer')?.getOrigin?.();
    if (typeof origin !== 'string' || origin === '') {
      this.log('宿主 web server 尚未就绪，浮窗稍后重试', true);
      this.schedulePanelRestart();
      return;
    }
    /** @type {string[]} */
    const args = [
      PANEL_SCRIPT,
      '--state-url', `${origin}/api/dsh-task-status-window/state`,
      '--focus-url', `${origin}/api/dsh-task-status-window/focus`,
      '--geometry-url', `${origin}/api/dsh-task-status-window/geometry`,
      '--topmost-url', `${origin}/api/dsh-task-status-window/topmost`,
      '--close-url', `${origin}/api/dsh-task-status-window/close`,
      '--token', this.token,
      '--width', String(geometry.width),
      '--x', String(geometry.x),
      '--y', String(geometry.y),
      '--poll', String(readField(this.config, 'pollIntervalMs', 800)),
      '--topmost', readField(this.config, 'alwaysOnTop', true) !== false ? '1' : '0',
      '--parent-pid', String(process.pid),
    ];
    let child;
    try {
      child = spawn(python, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.log(`浮窗进程启动失败：${error instanceof Error ? error.message : String(error)}`, true);
      this.schedulePanelRestart();
      return;
    }
    // 每一代浮窗进程都有一个编号：旧进程退出时如果自己已经不是当前这一代，
    // 就不再安排重启，避免出现多个浮窗叠在一起。
    this.panelGeneration += 1;
    const generation = this.panelGeneration;
    this.panel = child;
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') this.log(`浮窗：${text}`);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') this.log(`浮窗错误：${text}`, true);
    });
    child.on('exit', (code, signal) => {
      if (generation !== this.panelGeneration) return;
      this.panel = undefined;
      if (!this.panelWanted) return;
      this.log(`浮窗进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），将重新拉起`, true);
      this.schedulePanelRestart();
    });
    this.log('浮窗进程已启动');
  }

  /**
   * 安排一次浮窗重启。
   */
  schedulePanelRestart() {
    if (this.panelTimer !== undefined) clearTimeout(this.panelTimer);
    this.panelTimer = setTimeout(() => {
      this.panelTimer = undefined;
      this.startPanel();
    }, PANEL_RESTART_DELAY_MS);
    this.panelTimer.unref?.();
  }

  /**
   * 停止浮窗进程。
   */
  stopPanel() {
    this.panelWanted = false;
    if (this.panelTimer !== undefined) {
      clearTimeout(this.panelTimer);
      this.panelTimer = undefined;
    }
    const child = this.panel;
    // 递增编号，让正在退出的旧进程不再安排重启。
    this.panelGeneration += 1;
    this.panel = undefined;
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      /* 进程已经退出 */
    }
  }

  /**
   * 监听运行时的状态事实。
   */
  watchRuntime() {
    const agents = this.ctx.get('agents');
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        if (agent.status === 'running') this.running.add(agent.id);
      }
    }
    this.ctx.on('agent/status', ({ agent, status }) => {
      const id = agent.id;
      if (status === 'running') {
        this.running.add(id);
        this.completed.delete(id);
        return;
      }
      if (!this.running.delete(id)) return;
      if (!this.pending.has(id)) this.completed.add(id);
    });
    this.ctx.on('agent/disposed', ({ agent }) => {
      this.running.delete(agent.id);
      this.pending.delete(agent.id);
      this.completed.delete(agent.id);
    });
    // 这两个事件是瀑布式的：谁先回答就由谁处理，后面的人根本不会被调用。
    // 界面自己（以及别的 answerer）会抢在前面把请求接走，因此我们得插到队首，
    // 只做记录再原样 next() 交给后面的处理者。
    this.ctx.on('approval/request', async (request, next) => {
      const id = request.agent?.id;
      if (id !== undefined) this.pending.set(id, 'approval');
      try {
        return await next();
      } finally {
        if (id !== undefined && this.pending.get(id) === 'approval') this.pending.delete(id);
      }
    }, { prepend: true });
    this.ctx.on('user-questions/request', async (request, next) => {
      const id = request.agent?.id;
      if (id !== undefined) {
        const kinds = (request.questions ?? []).map((item) => item?.intent?.kind);
        const kind = kinds.includes('plan-review')
          ? 'plan-review'
          : kinds.includes('approval')
            ? 'approval'
            : 'question';
        this.pending.set(id, kind);
      }
      try {
        return await next();
      } finally {
        if (id !== undefined && this.pending.has(id)) this.pending.delete(id);
      }
    }, { prepend: true });
  }

  /**
   * 注册插件自己的路由族。
   */
  registerRoutes() {
    const guardToken = (req, res) => {
      const value = req.headers?.[TOKEN_HEADER];
      if (typeof value !== 'string' || value !== this.token) {
        writeJson(res, 403, { error: 'forbidden' });
        return false;
      }
      return true;
    };
    const guardOrigin = (req, res) => {
      // 宿主自己的信任栅栏：Host/Origin 检查 + 浏览器会话认证。桌面端转发过来
      // 的请求没有 Origin（外壳替它去掉了），但带着宿主签发的会话 cookie，
      // 因此两者都能通过；本机上的其它页面则过不去。
      const rejection = this.ctx.get('connection')?.requestRejection?.(req);
      if (rejection !== undefined) {
        writeJson(res, rejection, { error: 'forbidden' });
        return false;
      }
      return true;
    };
    const routes = [
      {
        kind: 'exact',
        path: ROUTES.state,
        handler: (req, res) => {
          if (!guardToken(req, res)) return;
          writeJson(res, 200, this.state());
        },
      },
      {
        kind: 'exact',
        path: ROUTES.geometry,
        handler: async (req, res) => {
          if (!guardToken(req, res)) return;
          const body = await readJsonBody(req);
          const width = Number(body?.width);
          const x = Number(body?.x);
          const y = Number(body?.y);
          if (![width, x, y].every((value) => Number.isFinite(value))) {
            writeJson(res, 400, { error: 'invalid geometry' });
            return;
          }
          // 尺寸明显不合理的回报来自窗口还没铺开的瞬间，直接拒绝，免得把配置
          // 写成用户没法用的数值。
          if (width < 120) {
            this.log(`忽略了不合理的窗口宽度回报：${width}`, true);
            writeJson(res, 400, { error: 'implausible geometry' });
            return;
          }
          // 高度跟着任务多少走，不是用户定的，因此只记宽度与位置。
          this.scheduleGeometryWrite({
            width: Math.max(240, Math.min(1600, width)),
            x: Math.max(-20000, Math.min(20000, Math.round(x))),
            y: Math.max(-20000, Math.min(20000, Math.round(y))),
          });
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.focus,
        handler: async (req, res) => {
          if (!guardToken(req, res)) return;
          const body = await readJsonBody(req);
          const sessionId = body?.sessionId;
          if (typeof sessionId !== 'string' || sessionId === '') {
            writeJson(res, 400, { error: 'sessionId is required' });
            return;
          }
          this.requestFocus(sessionId);
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.topmost,
        handler: async (req, res) => {
          if (!guardToken(req, res)) return;
          const body = await readJsonBody(req);
          const topmost = body?.topmost;
          if (typeof topmost !== 'boolean') {
            writeJson(res, 400, { error: 'topmost must be a boolean' });
            return;
          }
          await this.writeConfig({ alwaysOnTop: topmost });
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.close,
        handler: async (req, res) => {
          if (!guardToken(req, res)) return;
          // 关闭浮窗等于把「显示浮窗」关掉：用户可以在插件管理页里再打开。
          this.panelWanted = false;
          await this.writeConfig({ enabled: false });
          this.stopPanel();
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.theme,
        handler: async (req, res) => {
          if (!guardOrigin(req, res)) return;
          const body = await readJsonBody(req);
          const payload = body;
          if (typeof payload !== 'object' || payload === null) {
            writeJson(res, 400, { error: 'tokens are required' });
            return;
          }
          this.applyTheme(payload);
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.statuses,
        handler: async (req, res) => {
          if (!guardOrigin(req, res)) return;
          const body = await readJsonBody(req);
          const clientId = typeof body?.clientId === 'string' && body.clientId !== '' ? body.clientId : 'default';
          // 桌面端（主体程序）与浏览器标签页要分开记：切任务的请求只交给桌面端。
          const kind = body?.kind === 'desktop' ? 'desktop' : 'web';
          const rows = Array.isArray(body?.statuses) ? body.statuses : [];
          /** @type {Map<string, {running: boolean, unread: boolean}>} */
          const records = new Map();
          /** @type {Map<string, string>} */
          const pending = new Map();
          for (const row of rows) {
            if (typeof row?.id !== 'string' || row.id === '') continue;
            records.set(row.id, { running: row.running === true, unread: row.unread === true });
            if (typeof row.pendingKind === 'string' && row.pendingKind !== '') {
              pending.set(row.id, row.pendingKind);
            }
          }
          // 界面说「刚才还亮着、现在不亮了」的那些：记成一条什么都不成立的
          // 记录。合并时按时间取最新的一份，绿点才会跟着界面一起消掉。
          const cleared = Array.isArray(body?.cleared) ? body.cleared : [];
          for (const id of cleared) {
            if (typeof id !== 'string' || id === '') continue;
            records.set(id, { running: false, unread: false });
            // 宿主自己也记着「刚跑完还没确认」，界面说读过了就别再留着绿点。
            this.completed.delete(id);
          }
          this.clients.set(clientId, { at: Date.now(), records, pending, kind });
          writeJson(res, 200, { ok: true });
        },
      },
      {
        kind: 'exact',
        path: ROUTES.claim,
        handler: async (req, res) => {
          if (!guardOrigin(req, res)) return;
          const body = await readJsonBody(req);
          const kind = body?.kind === 'desktop' ? 'desktop' : 'web';
          // 领取一次就清掉，因此这里只能调一次。
          const claimed = this.claimFocus(kind);
          // themeReceived 让页面知道宿主是否还留着它上次发来的主题：宿主
          // 重启之后主题会退回兜底值，页面据此重发一次。
          writeJson(res, 200, {
            focus: claimed,
            themeReceived: this.themeReceived,
          });
        },
      },
    ];
    const disposers = routes.map((route) => this.ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /**
   * 让浮窗进程的存在与配置保持一致。
   *
   * 用户在插件管理页关掉「显示浮窗」时，浮窗进程要退出；重新打开时它要再
   * 次被拉起。配置是 volatile 的，改动不会重启插件，因此这里主动对齐一次。
   */
  reconcilePanel() {
    const wanted = readField(this.config, 'enabled', true) !== false;
    if (wanted === this.panelWanted) {
      this.reconcileGeometry();
      return;
    }
    this.panelWanted = wanted;
    if (wanted) {
      this.log('浮窗已重新打开');
      this.startPanel();
      return;
    }
    this.log('浮窗已关闭');
    this.stopPanel();
  }
  /**
   * 让已经跑着的浮窗跟上配置里改过的尺寸与位置。
   *
   * 浮窗进程只在启动时读一次几何，因此这里比较配置与进程最后一次知道的
   * 几何：不一样就把进程换成新的，让它按新几何重新摆好。
   */
  reconcileGeometry() {
    if (this.panel === undefined) return;
    const geometry = this.geometry();
    const applied = this.appliedGeometry;
    if (applied === undefined) {
      this.appliedGeometry = geometry;
      return;
    }
    if (
      applied.width === geometry.width
      && applied.x === geometry.x
      && applied.y === geometry.y
    ) {
      return;
    }
    this.appliedGeometry = geometry;
    this.log('窗口设置已改变，重新摆放浮窗');
    const child = this.panel;
    // 递增代数，让旧进程的退出不再安排一次重启。
    this.panelGeneration += 1;
    this.panel = undefined;
    try {
      child.kill();
    } catch {
      /* 进程已经退出 */
    }
    this.startPanel();
  }

  /**
   * 启动整个运行时。
   */
  start() {
    this.watchRuntime();
    const disposeRoutes = this.registerRoutes();
    this.panelWanted = readField(this.config, 'enabled', true) !== false;
    if (this.panelWanted) this.startPanel();
    const reconcileTimer = setInterval(() => this.reconcilePanel(), PANEL_RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
    return () => {
      clearInterval(reconcileTimer);
      disposeRoutes();
      this.stopPanel();
      if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
      if (this.panelTimer !== undefined) clearTimeout(this.panelTimer);
      if (this.lastGeometry !== undefined) void this.writeGeometry(this.lastGeometry);
    };
  }
}

/**
 * 宿主插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 插件配置。
 */
export function apply(ctx, config) {
  const runtime = new TaskStatusWindowRuntime(ctx, config);
  ctx.effect(() => runtime.start(), 'dsh-task-status-window: runtime');
}
