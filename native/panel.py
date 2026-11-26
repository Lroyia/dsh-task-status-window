#!/usr/bin/env python3
"""任务状态浮窗 —— 系统级置顶窗口。

这个进程由插件的 Host 半侧拉起，用 Python + Tk 画一个无边框、始终置顶的
小窗，列出 DeepSeek Harness 里正在运行、等待批准、办结待确认的任务。

它做这几件事：

* 按间隔从宿主读取任务清单、主题色板与文案；
* 用宿主给的颜色画圆角面板、状态圆点与任务行；
* 顶部栏上有三个按钮：收起/展开任务列表、置顶/取消置顶、关闭浮窗；标题旁边
  按任务清单里的状态显示对应的状态图标；
* 允许拖动标题栏移动窗口、拖右下角改变窗口宽度，并把几何回报给宿主（宿主
  会把它写回插件配置，下次启动按同样的尺寸恢复）；
* 任务标题放不下时缩略显示，鼠标悬停时用气泡显示完整标题；
* 点击某一行时把该任务切到前台：请求宿主把焦点交给浏览器半侧，同时用
  Win32 把 DeepSeek Harness 的主窗口拉到前面。

窗口完全由 Tk 绘制，因此不依赖 Electron，也不会因为宿主窗口最小化而消失。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any

try:
    import tkinter as tk
    import tkinter.font as tkfont
except ImportError as error:  # pragma: no cover - the runtime always ships Tk
    print(f"tkinter is unavailable: {error}", file=sys.stderr)
    raise SystemExit(2)


# --- 浮窗几何 ---------------------------------------------------------------

HEADER_HEIGHT = 40
# 与界面里工作区会话题目行同高。
ROW_HEIGHT = 32
PADDING = 10
GRIP_SIZE = 16
MIN_WIDTH = 240
MIN_HEIGHT = 40
# 任务列表底部的留白。
LIST_BOTTOM = 4
# 顶部栏里三个按钮的尺寸与间距。
BUTTON_SIZE = 22
BUTTON_GAP = 3
BUTTON_HOVER_PAD = 3
# 顶部栏里状态图标的间距。
ICON_GAP = 9
# 行尾计时的宽度留白（计时文字右对齐，左边留一点空）。
TIME_GAP = 8

# 标题放不下时走马灯：与界面里工作区题目行同一套参数 —— 溢出不到 8 像素
# 就不动（那点位移读起来像抖动），滚动速度 0.03 像素/毫秒。
MIN_TITLE_REVEAL_PX = 8
TITLE_MARQUEE_PX_PER_MS = 0.03

# --- 与界面里的状态点保持一致的尺寸 -----------------------------------------
#
# 界面的状态点是一个 10 像素的方框，圆点占其中 60%（直径 6 像素）；运行中的
# 加载图标是 14 像素的圆环：淡色的整圈轨道 + 一段会呼吸的圆弧。浮窗照搬这套
# 尺寸与画法，看起来才和主界面是同一套东西。
DOT_BOX = 10
DOT_RADIUS = DOT_BOX * 0.3
SPINNER_SIZE = 14
# 加载图标在界面里是 24 单位的 viewBox，圆环半径 9.5、线宽 2。
SPINNER_VIEWBOX = 24.0
SPINNER_RADIUS_RATIO = 9.5 / 12.0
SPINNER_STROKE_RATIO = 2.0 / 24.0
SPINNER_PERIOD = 1.5

# 图钉按钮用界面自己那套 icon：16 单位的 viewBox，实心/空心两种。
PIN_ICON_SIZE = 14
PIN_BODY_PATH = (
    "M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605"
    "L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z"
)
PIN_NEEDLE_PATH = (
    "M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457"
    "C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708"
    "L3.21223 13.9291L6.05285 9.47511Z"
)
PIN_VIEWBOX = 16.0
PIN_STROKE = 1.5

# 浮窗用这个颜色做透明键：窗口的四个角上它被抠掉，圆角之外就是透明的。
TRANSPARENT_KEY = "#010203"

# 顶部栏右侧的三个按钮，顺序即从左到右的顺序。
HEADER_BUTTONS = ("collapse", "topmost", "close")
# 顶部栏里可能出现的三个状态图标，顺序即从左到右的顺序。
HEADER_STATES = ("running", "warning", "done")


# --- 配色与文案的兜底值 ---------------------------------------------------

FALLBACK_THEME = {
    "surface": "#f7f8fa",
    "background": "#ffffff",
    "border": "#e3e5ea",
    "text": "#0f1115",
    "muted": "#6b7280",
    "running": "#6b7280",
    "warning": "#d9822b",
    "success": "#3f9e5a",
    "idle": "#9aa1ad",
    "font": "Segoe UI",
}

FALLBACK_LABELS = {
    "title": "任务状态",
    "empty": "当前没有需要关注的任务",
    "timeNow": "刚刚",
    "timeMinutes": "{n}分钟",
    "timeHours": "{n}小时",
    "timeDays": "{n}天",
    "timeMonths": "{n}个月",
    "timeYears": "{n}年",
    "pendingApproval": "待审批",
    "pendingPlanReview": "计划待审",
    "pendingAnswer": "待回答",
}

STATE_COLORS = {
    "running": "running",
    "warning": "warning",
    "done": "success",
}


# --- 宿主通信 ---------------------------------------------------------------


class Host:
    """与宿主插件路由族通信的小客户端。"""

    def __init__(
        self,
        state_url: str,
        focus_url: str,
        geometry_url: str,
        token: str,
        topmost_url: str,
        close_url: str,
    ) -> None:
        self.state_url = state_url
        self.focus_url = focus_url
        self.geometry_url = geometry_url
        self.topmost_url = topmost_url
        self.close_url = close_url
        self.token = token

    def _request(self, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None
        headers = {"x-dsh-task-window-token": self.token, "accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=4) as response:
            body = response.read()
        parsed = json.loads(body.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}

    def state(self) -> dict[str, Any]:
        return self._request(self.state_url)

    def focus(self, session_id: str) -> None:
        try:
            self._request(self.focus_url, {"sessionId": session_id})
        except (urllib.error.URLError, OSError, ValueError):
            pass

    def geometry(self, x: int, y: int, width: int) -> None:
        try:
            self._request(
                self.geometry_url,
                {"x": x, "y": y, "width": width},
            )
        except (urllib.error.URLError, OSError, ValueError):
            pass

    def set_topmost(self, topmost: bool) -> None:
        """告诉宿主置顶状态变了，让宿主把它记进配置。"""
        try:
            self._request(self.topmost_url, {"topmost": topmost})
        except (urllib.error.URLError, OSError, ValueError):
            pass

    def close(self) -> None:
        """告诉宿主关闭浮窗；宿主会把「显示浮窗」关掉，之后可以在插件管理页再打开。"""
        try:
            self._request(self.close_url, {})
        except (urllib.error.URLError, OSError, ValueError):
            pass


# --- 把 DeepSeek Harness 的主窗口拉到前面 ----------------------------------


def activate_harness() -> None:
    """把 DeepSeek Harness 的主窗口恢复并置于最前。

    只有 Windows 有可用的做法：枚举顶层窗口，找到属于 DeepSeek Harness 进程
    且可见的窗口，然后恢复并置前。其它平台留空，浏览器半侧仍会切到对应的
    任务，只是窗口不会自动被拉到前面。
    """
    if sys.platform != "win32":
        return
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
    except (AttributeError, OSError):
        return

    matches: list[int] = []

    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def collect(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if "DeepSeek Harness" not in title:
            return True
        process_id = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        handle = kernel32.OpenProcess(0x1000, False, process_id.value)
        name = ""
        if handle:
            size = ctypes.c_ulong(260)
            name_buffer = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, name_buffer, ctypes.byref(size)):
                name = os.path.basename(name_buffer.value)
            kernel32.CloseHandle(handle)
        if name and "DeepSeek Harness" not in name:
            return True
        matches.append(hwnd)
        return True

    try:
        user32.EnumWindows(enum_proc(collect), 0)
    except OSError:
        return
    for hwnd in matches:
        # SW_RESTORE 会把最大化窗口还原成初始大小——用户正在全屏看东西时点
        # 一下任务，窗口却「掉」回小尺寸，这很莫名其妙。只在窗口确实最小化
        # 时才用它；最大化的窗口保持原样，只把它叫到前面来。
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        break


# --- 绘制辅助 ---------------------------------------------------------------


def rounded_rect(
    canvas: tk.Canvas,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    radius: float,
    **kwargs: Any,
) -> int:
    """画一个圆角矩形。

    Tk 没有圆角矩形图元，这里用一段采样过的多边形近似。
    """
    radius = max(0.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
    steps = 6
    points: list[float] = []
    corners = (
        (x2 - radius, y1 + radius, -90.0, 0.0),
        (x2 - radius, y2 - radius, 0.0, 90.0),
        (x1 + radius, y2 - radius, 90.0, 180.0),
        (x1 + radius, y1 + radius, 180.0, 270.0),
    )
    for cx, cy, start, end in corners:
        for index in range(steps + 1):
            angle = start + (end - start) * index / steps
            points.append(cx + radius * math.cos(math.radians(angle)))
            points.append(cy + radius * math.sin(math.radians(angle)))
    return canvas.create_polygon(points, smooth=True, **kwargs)


def pick_font_family(candidates: list[str]) -> str:
    """挑一个系统里真的有的字体族。

    主题给的字体栈是 CSS 写法，名字里可能带引号（``"Segoe UI"``），Tk 不认
    带引号的名字，不去掉引号就会一路落到 Arial 之类的兜底字体上去。
    """
    try:
        available = set(tkfont.families())
    except tk.TclError:
        return candidates[0] if candidates else "Segoe UI"
    for family in candidates:
        name = family.strip().strip("\"'")
        if name in available:
            return name
    return candidates[0] if candidates else "Segoe UI"


# 系统里带中文字形、并且笔画跟界面一致的字体族，按这个顺序挑。
#
# 界面（浏览器）按字形逐个回落：拉丁字形用栈里第一个有的字体，中文字形用系
# 统的中文 **UI** 字体（Windows 上是「Microsoft YaHei UI」），笔画很细。
# Tk 走的是 GDI，它的字体回落会挑「非 UI 款」的中文字体，笔画明显更粗 ——
# 所以这里对中文直接点名用 UI 款，跟界面对上。
CJK_FAMILIES = (
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "PingFang SC",
    "Hiragino Sans GB",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Noto Sans SC",
    "SimHei",
    "SimSun",
)

# CJK 统一表意文字（含扩展 A 与兼容表意文字）。
_CJK_RANGES = (
    (0x2E80, 0x9FFF),
    (0xF900, 0xFAFF),
    (0xFF00, 0xFFEF),
    (0x3000, 0x303F),
)


def has_cjk(text: str) -> bool:
    """文字里有没有中文（含中文标点）。"""
    for char in text:
        code = ord(char)
        for low, high in _CJK_RANGES:
            if low <= code <= high:
                return True
    return False


# --- SVG 路径（图钉图标直接复用界面自己的画法） ----------------------------

_PATH_TOKEN = re.compile(r"[MLCZmlcz]|-?\d+(?:\.\d+)?")


def svg_path_points(path: str, scale: float, offset_x: float, offset_y: float) -> list[list[tuple[float, float]]]:
    """把一段 SVG 路径展开成多边形点集。

    只支持界面图标实际用到的那几条命令：M/L/C/Z（含小写相对写法）。每段闭合
    的子路径成为一组点，调用方按需要填充或描边。
    """
    tokens = _PATH_TOKEN.findall(path)
    polygons: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    start = (0.0, 0.0)
    command = "M"
    index = 0

    def place(x: float, y: float) -> tuple[float, float]:
        return offset_x + x * scale, offset_y + y * scale

    while index < len(tokens):
        token = tokens[index]
        if token.isalpha():
            command = token
            index += 1
            if command in ("Z", "z"):
                if current:
                    # 闭合点要用变换后的坐标：start 还留在路径坐标系里，
                    # 直接塞进去会画出一条甩到左上角的线。
                    current.append(place(*start))
                    polygons.append(current)
                    current = []
                cursor = start
            continue
        relative = command.islower()
        kind = command.upper()
        if kind == "M":
            x = float(tokens[index])
            y = float(tokens[index + 1])
            index += 2
            point = (cursor[0] + x, cursor[1] + y) if relative else (x, y)
            if current:
                polygons.append(current)
            current = [place(*point)]
            cursor = point
            start = point
            command = "l" if relative else "L"
        elif kind == "L":
            x = float(tokens[index])
            y = float(tokens[index + 1])
            index += 2
            point = (cursor[0] + x, cursor[1] + y) if relative else (x, y)
            current.append(place(*point))
            cursor = point
        elif kind == "C":
            numbers = [float(tokens[index + step]) for step in range(6)]
            index += 6
            if relative:
                p1 = (cursor[0] + numbers[0], cursor[1] + numbers[1])
                p2 = (cursor[0] + numbers[2], cursor[1] + numbers[3])
                p3 = (cursor[0] + numbers[4], cursor[1] + numbers[5])
            else:
                p1 = (numbers[0], numbers[1])
                p2 = (numbers[2], numbers[3])
                p3 = (numbers[4], numbers[5])
            x0, y0 = cursor
            for step in range(1, 13):
                t = step / 12.0
                mt = 1.0 - t
                bx = mt**3 * x0 + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
                by = mt**3 * y0 + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
                current.append(place(bx, by))
            cursor = p3
        else:
            index += 1
    if current:
        polygons.append(current)
    return polygons


# --- 相对时间（与界面里的工作区题目行一致） --------------------------------


def relative_label(since: float, now: float, labels: dict[str, Any]) -> str:
    """把「从某个时刻到现在」写成人话，与界面里的计时口径一致。

    @param since - 起始时刻（Unix 毫秒）。
    @param now - 当前时刻（Unix 毫秒）。
    @param labels - 文案表。
    @returns 例如「刚刚」「12分钟」「3小时」。
    """
    seconds = max(0.0, (now - since) / 1000.0)
    if seconds < 60:
        return str(labels.get("timeNow", "刚刚"))
    minutes = int(seconds // 60)
    if minutes < 60:
        return str(labels.get("timeMinutes", "{n}分钟")).replace("{n}", str(minutes))
    hours = int(minutes // 60)
    if hours < 24:
        return str(labels.get("timeHours", "{n}小时")).replace("{n}", str(hours))
    days = int(hours // 24)
    if days < 30:
        return str(labels.get("timeDays", "{n}天")).replace("{n}", str(days))
    months = int(days // 30)
    if months < 12:
        return str(labels.get("timeMonths", "{n}个月")).replace("{n}", str(months))
    return str(labels.get("timeYears", "{n}年")).replace("{n}", str(int(days // 365)))


# --- 浮窗 -------------------------------------------------------------------


class Panel:
    """无边框置顶浮窗。"""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.host = Host(
            args.state_url,
            args.focus_url,
            args.geometry_url,
            args.token,
            args.topmost_url,
            args.close_url,
        )
        self.interval = max(0.2, float(args.poll) / 1000.0)
        self.parent_pid = args.parent_pid
        self.state: dict[str, Any] = {}
        self.theme: dict[str, Any] = dict(FALLBACK_THEME)
        self.labels: dict[str, Any] = dict(FALLBACK_LABELS)
        self.tasks: list[dict[str, Any]] = []
        self.hover: int = -1
        self.hover_button: str | None = None
        self.pressed_button: str | None = None
        self.drag_offset: tuple[int, int] | None = None
        self.resize_origin: tuple[int, int, int, int] | None = None
        self.moved = False
        self.user_moved = False
        self.inbox: queue.Queue[dict[str, Any]] = queue.Queue()
        self.requested: tuple[int, int, int, int] = (360, 460, -1, -1)
        self.last_reported: tuple[int, int, int, int] | None = None
        self.pending_geometry: tuple[int, int, int, int] | None = None
        self.pending_since = 0.0
        # 任务列表的高度跟着任务多少走：一个任务一行，没有任务也留一行的高度。
        self.collapsed = False
        self.auto_position = args.x < 0 or args.y < 0
        self.scroll_offset = 0
        # 顶部栏里各元素的位置，每次重画时重算。
        self.header_buttons: list[tuple[str, float, float, float, float]] = []
        self.header_icons: list[tuple[str, float, float]] = []
        # 走马灯：正在滚动的行、已经滚过的像素、上次推进的时刻。
        self.marquee_row = -1
        self.marquee_offset = 0.0
        self.marquee_last = 0.0
        # 用户刚点过置顶按钮时，先按用户的意思走，等宿主把配置改好再对齐。
        self.topmost_local_until = 0.0

        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.title("DeepSeek Harness 任务状态")
        self.topmost = args.topmost == 1
        try:
            self.root.attributes("-topmost", self.topmost)
        except tk.TclError:
            self.topmost = False
        # 窗口本身是直角的，只有画出来的面板是圆角。把四角抠成透明，浮窗外面
        # 才不会露出一圈深色的直角框。
        self.root.configure(bg=TRANSPARENT_KEY)
        try:
            self.root.attributes("-transparentcolor", TRANSPARENT_KEY)
        except tk.TclError:
            pass

        # 字体：拉丁字形跟界面用同一个字体族；中文字形用系统的中文 UI 字体
        # （笔画跟界面一样细，见 CJK_FAMILIES 的说明）。
        latin_family = pick_font_family(
            [
                *[part.strip() for part in str(self.theme.get("font", "")).split(",") if part.strip()],
                "Segoe UI",
                "Helvetica",
            ]
        )
        cjk_family = pick_font_family(list(CJK_FAMILIES))
        if latin_family == cjk_family:
            # 主题本身就用中文字体，那拉丁字形也用同一个。
            cjk_family = latin_family
        self.font_title = tkfont.Font(family=latin_family, size=10, weight="bold")
        self.font_title_cjk = tkfont.Font(family=cjk_family, size=10, weight="bold")
        # 行题：界面里是 14 像素，行尾计时是 10 像素。
        self.font_row = tkfont.Font(family=latin_family, size=11)
        self.font_row_cjk = tkfont.Font(family=cjk_family, size=11)
        self.font_time = tkfont.Font(family=latin_family, size=8)
        self.font_time_cjk = tkfont.Font(family=cjk_family, size=8)

        self.canvas = tk.Canvas(
            self.root,
            width=1,
            height=1,
            highlightthickness=0,
            bd=0,
            bg=TRANSPARENT_KEY,
        )
        self.canvas.pack(fill="both", expand=True)

        self.canvas.bind("<Button-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<Leave>", self.on_leave)
        self.canvas.bind("<MouseWheel>", self.on_wheel)

        self.place_window(args.width, args.x, args.y)
        self.root.after(60, self.pump)
        self.root.after(0, self.draw)
        threading.Thread(target=self.poll_loop, daemon=True).start()
        threading.Thread(target=self.watchdog_loop, daemon=True).start()

    # -- 窗口 -------------------------------------------------------------

    def virtual_screen(self) -> tuple[int, int, int, int]:
        """返回虚拟屏幕的 (左, 上, 宽, 高)。

        多显示器时虚拟屏幕比主屏大，浮窗可以被拖到副屏上。
        """
        if sys.platform == "win32":
            try:
                user32 = ctypes.windll.user32
                left = int(user32.GetSystemMetrics(76))
                top = int(user32.GetSystemMetrics(77))
                width = int(user32.GetSystemMetrics(78))
                height = int(user32.GetSystemMetrics(79))
                if width > 0 and height > 0:
                    return left, top, width, height
            except (AttributeError, OSError):
                pass
        return 0, 0, self.root.winfo_screenwidth(), self.root.winfo_screenheight()

    def clamp(self, x: int, y: int, width: int, height: int) -> tuple[int, int]:
        """把窗口位置限制在虚拟屏幕内，避免浮窗被拖到找不回来的地方。"""
        left, top, screen_width, screen_height = self.virtual_screen()
        max_x = left + screen_width - width
        max_y = top + screen_height - height
        return max(left, min(max_x, x)), max(top, min(max_y, y))

    def header_min_width(self) -> int:
        """顶部栏放得下全部内容所需的最小宽度。

        顶部栏里有标题、三个状态图标与三个按钮，因此宽度不能小于它们加起来
        的宽度，否则按钮会被挤出窗口。
        """
        title = str(self.labels.get("title", "任务状态"))
        title_width = self.font_for(title, self.font_title, self.font_title_cjk).measure(title)
        icons = len(HEADER_STATES) * (SPINNER_SIZE + ICON_GAP)
        buttons = len(HEADER_BUTTONS) * BUTTON_SIZE + (len(HEADER_BUTTONS) - 1) * BUTTON_GAP
        return int(PADDING + title_width + ICON_GAP + icons + 16 + buttons + PADDING)

    def min_width(self) -> int:
        """浮窗允许的最小宽度：至少要放得下顶部栏。"""
        return max(MIN_WIDTH, self.header_min_width())

    def max_window_height(self) -> int:
        """浮窗允许的最大高度：不能高过屏幕，否则任务再多也看不见。"""
        _left, _top, _screen_width, screen_height = self.virtual_screen()
        return max(MIN_HEIGHT + ROW_HEIGHT, int(screen_height * 0.8))

    def list_height(self) -> int:
        """任务列表该有多高。

        列表跟着任务多少走：一个任务占一行；没有任务时也留一行的高度，好让
        「当前没有需要关注的任务」这句话有地方显示。任务多到超过屏幕时封顶，
        剩下的靠滚动。
        """
        rows = max(1, len(self.tasks))
        wanted = rows * ROW_HEIGHT + LIST_BOTTOM
        return min(wanted, self.max_window_height() - HEADER_HEIGHT)

    def window_height(self) -> int:
        """浮窗该有多高。"""
        if self.collapsed:
            return HEADER_HEIGHT
        return HEADER_HEIGHT + self.list_height()

    def auto_placement(self, width: int, height: int) -> tuple[int, int]:
        """自动定位：浮窗落在虚拟屏幕的右下角。"""
        left, top, screen_width, screen_height = self.virtual_screen()
        return left + screen_width - width - 24, top + screen_height - height - 48

    def sync_height(self) -> None:
        """任务多少变了，浮窗跟着变高变矮。"""
        wanted = self.window_height()
        current = self.root.winfo_height()
        if current == wanted:
            return
        width = max(self.min_width(), self.root.winfo_width())
        if self.auto_position:
            x, y = self.auto_placement(width, wanted)
        else:
            x, y = self.root.winfo_x(), self.root.winfo_y()
        x, y = self.clamp(x, y, width, wanted)
        self.root.geometry(f"{width}x{wanted}+{x}+{y}")
        self.root.update_idletasks()
        # 高度变了，重新记一次基准，免得把它当成用户改动回报出去。
        self.last_reported = None
        self.scroll_offset = 0

    def place_window(self, width: int, x: int, y: int) -> None:
        """按配置的宽度与位置摆放窗口。

        高度跟着任务多少走，不用配置。x 或 y 为 -1 表示那一轴落在虚拟屏幕的
        右下角，两轴互不影响：这样「水平自动、垂直固定」也能表达。
        """
        width = max(self.min_width(), int(width))
        # 高度跟着任务多少走，不用配置里的值。
        height = self.window_height()
        left, top, screen_width, screen_height = self.virtual_screen()
        if x < 0:
            x = left + screen_width - width - 24
        if y < 0:
            y = top + screen_height - height - 48
        x, y = self.clamp(int(x), int(y), width, height)
        self.requested = (width, height, x, y)
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        # 画布的请求尺寸是一像素，第一次映射之后 Tk 会按请求尺寸重排窗口，
        # 因此这里把几何再摆一次，确保浮窗就是配置里写的那个尺寸。
        self.root.update_idletasks()
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.root.update_idletasks()
        # 仍然不是配置里的尺寸时，说明窗口管理器接管了摆放，再摆一次。
        if self.root.winfo_width() != width or self.root.winfo_height() != height:
            self.root.geometry(f"{width}x{height}+{x}+{y}")
            self.root.update_idletasks()

    # -- 状态轮询 ----------------------------------------------------------

    def parent_alive(self) -> bool:
        """宿主进程是否还在。

        宿主退出后浮窗必须跟着退出，否则用户会看到一个再也更新不了的窗口。
        """
        if self.parent_pid is None or self.parent_pid <= 0:
            return True
        if sys.platform == "win32":
            try:
                handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, self.parent_pid)
                if handle == 0:
                    return False
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            except (AttributeError, OSError):
                return True
        try:
            os.kill(self.parent_pid, 0)
            return True
        except OSError:
            return False

    def watchdog_loop(self) -> None:
        """宿主不在了就退出浮窗。"""
        while True:
            if not self.parent_alive():
                os._exit(0)
            threading.Event().wait(2.0)

    def poll_loop(self) -> None:
        """在后台线程里按间隔读取宿主状态。"""
        while True:
            try:
                state = self.host.state()
                self.inbox.put({"type": "state", "state": state})
            except (urllib.error.URLError, OSError, ValueError):
                self.inbox.put({"type": "state", "state": None})
            threading.Event().wait(self.interval)

    def pump(self) -> None:
        """在主线程里取回后台读到的状态。"""
        try:
            while True:
                message = self.inbox.get_nowait()
                if message.get("type") == "state" and isinstance(message.get("state"), dict):
                    self.apply_state(message["state"])
                self.draw()
        except queue.Empty:
            pass
        self.check_geometry()
        # 有任务在跑的时候加载图标要转起来，因此即使没有新状态也要重画。
        running = any(str(task.get("state", "")) == "running" for task in self.tasks)
        marqueeing = self.marquee_step()
        if running or marqueeing:
            self.draw()
        self.root.after(40 if (running or marqueeing) else 150, self.pump)

    def apply_state(self, state: dict[str, Any]) -> None:
        """把宿主下发的状态收进浮窗。"""
        self.state = state
        theme = state.get("theme")
        if isinstance(theme, dict):
            self.theme.update({k: v for k, v in theme.items() if isinstance(v, str)})
        labels = state.get("labels")
        if isinstance(labels, dict):
            self.labels.update({k: v for k, v in labels.items() if isinstance(v, str)})
        tasks = state.get("tasks")
        if isinstance(tasks, list):
            self.tasks = [task for task in tasks if isinstance(task, dict)]
        always = state.get("alwaysOnTop")
        # 用户刚点过置顶按钮时，先按用户的意思走，等宿主把配置改好再对齐。
        if (
            isinstance(always, bool)
            and always != self.topmost
            and time.monotonic() > self.topmost_local_until
        ):
            self.topmost = always
            try:
                self.root.attributes("-topmost", always)
            except tk.TclError:
                pass
        poll = state.get("pollIntervalMs")
        if isinstance(poll, (int, float)) and poll > 0:
            self.interval = max(0.2, float(poll) / 1000.0)
        auto = state.get("autoPosition")
        if isinstance(auto, bool):
            self.auto_position = auto
        self.ensure_width()
        self.sync_height()
        self.clamp_scroll()

    def ensure_width(self) -> None:
        """窗口比顶部栏需要的宽度还窄时，把它撑开。"""
        needed = self.min_width()
        if self.root.winfo_width() >= needed:
            return
        x, y = self.root.winfo_x(), self.root.winfo_y()
        height = self.window_height()
        self.root.geometry(f"{needed}x{height}+{x}+{y}")
        self.root.update_idletasks()

    # -- 绘制 -------------------------------------------------------------

    def blend(self, color: str, background: str, alpha: float) -> str:
        """把颜色按透明度混进背景色，用来画半透明的轨道。"""
        try:
            fr, fg, fb = (int(color[i : i + 2], 16) for i in (1, 3, 5))
            br, bg, bb = (int(background[i : i + 2], 16) for i in (1, 3, 5))
        except (ValueError, TypeError):
            return color
        mix = lambda a, b: max(0, min(255, round(b + (a - b) * alpha)))
        return f"#{mix(fr, br):02x}{mix(fg, bg):02x}{mix(fb, bb):02x}"

    def spinner_state(self) -> tuple[float, float, float]:
        """加载动画的当前状态。

        照搬界面里的做法：整体匀速转一圈（1.5 秒），圆弧本身在 12 与 24 个
        单位之间呼吸。返回 (旋转角度, 圆弧张角, 圆弧起点偏移)，单位是度。
        """
        phase = (time.monotonic() % SPINNER_PERIOD) / SPINNER_PERIOD
        rotation = phase * 360.0
        # 虚线长度在两段之间往返，用平滑的缓动，看起来才不跳。
        u = phase / 0.5 if phase <= 0.5 else (1.0 - phase) / 0.5
        eased = u * u * (3.0 - 2.0 * u)
        circumference = 2.0 * math.pi * 9.5
        arc = (12.0 + 12.0 * eased) / circumference * 360.0
        offset = -6.0 * eased / circumference * 360.0
        return rotation, arc, offset

    def draw_spinner(self, canvas: tk.Canvas, cx: float, cy: float, color: str, background: str) -> None:
        """画加载图标：淡色的整圈轨道 + 一段会呼吸的圆弧。

        与界面里的加载动画同一套画法与尺寸。
        """
        rotation, arc, offset = self.spinner_state()
        radius = SPINNER_SIZE / 2.0 * SPINNER_RADIUS_RATIO
        stroke = max(1.0, SPINNER_SIZE * SPINNER_STROKE_RATIO)
        # 轨道：整圈，透明度 0.25。
        canvas.create_oval(
            cx - radius,
            cy - radius,
            cx + radius,
            cy + radius,
            outline=self.blend(color, background, 0.25),
            width=stroke,
        )
        # 圆弧：Tk 的圆弧没有圆头线帽，用一段折线代替。
        start = -(rotation + offset)
        steps = max(8, int(arc / 5.0))
        points: list[float] = []
        for index in range(steps + 1):
            angle = math.radians(start - arc * index / steps)
            points.append(cx + radius * math.cos(angle))
            points.append(cy + radius * math.sin(angle))
        canvas.create_line(
            *points,
            fill=color,
            width=stroke,
            capstyle="round",
            joinstyle="round",
        )

    def draw_dot(self, canvas: tk.Canvas, cx: float, cy: float, color: str) -> None:
        """画状态点：10 像素的方框里一个 6 像素的圆点，与界面一致。"""
        radius = DOT_RADIUS
        canvas.create_oval(
            cx - radius,
            cy - radius,
            cx + radius,
            cy + radius,
            fill=color,
            outline="",
        )

    def color(self, name: str, fallback: str) -> str:
        """取一个颜色，只接受 Tk 认识的十六进制写法。"""
        value = self.theme.get(name)
        if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value.strip()):
            return fallback
        return value.strip()

    def state_color(self, state: str) -> str:
        """取某个状态对应的颜色。"""
        return self.color(STATE_COLORS.get(state, "idle"), self.color("idle", "#9aa1ad"))

    def active_states(self) -> list[str]:
        """任务清单里出现过的状态，按 运行中 → 等待处理 → 办结待确认 排列。"""
        present = {str(task.get("state", "")) for task in self.tasks}
        return [state for state in HEADER_STATES if state in present]

    def layout_header(self, width: int) -> None:
        """算顶部栏里状态图标与按钮的位置。

        列表展开时状态在下面一行行写着，顶部栏不必重复；只有收起时列表看不
        见了，图标才出现在标题旁边。
        """
        title = str(self.labels.get("title", "任务状态"))
        title_width = self.font_for(title, self.font_title, self.font_title_cjk).measure(title)
        icons: list[tuple[str, float, float]] = []
        cursor = PADDING + title_width + ICON_GAP
        if self.collapsed:
            for state in self.active_states():
                icons.append((state, cursor + SPINNER_SIZE / 2, HEADER_HEIGHT / 2))
                cursor += SPINNER_SIZE + ICON_GAP
        self.header_icons = icons
        buttons: list[tuple[str, float, float, float, float]] = []
        right = width - PADDING
        for name in reversed(HEADER_BUTTONS):
            right -= BUTTON_SIZE
            buttons.append((name, right, 0.0, right + BUTTON_SIZE, float(HEADER_HEIGHT)))
            right -= BUTTON_GAP
        buttons.reverse()
        self.header_buttons = buttons

    def draw_glyph(self, canvas: tk.Canvas, name: str, cx: float, cy: float, color: str, filled: bool) -> None:
        """画顶部栏按钮上的图形。"""
        width = 1.6
        if name == "collapse":
            # 列表展开时给一个朝上的折角，点一下收起来。
            canvas.create_line(cx - 4, cy + 1.5, cx, cy - 2.5, fill=color, width=width, capstyle="round", joinstyle="round")
            canvas.create_line(cx, cy - 2.5, cx + 4, cy + 1.5, fill=color, width=width, capstyle="round", joinstyle="round")
        elif name == "expand":
            canvas.create_line(cx - 4, cy - 1.5, cx, cy + 2.5, fill=color, width=width, capstyle="round", joinstyle="round")
            canvas.create_line(cx, cy + 2.5, cx + 4, cy - 1.5, fill=color, width=width, capstyle="round", joinstyle="round")
        elif name == "topmost":
            # 图钉：直接用界面自己那套 icon —— 置顶时实心，取消置顶时只剩轮廓。
            self.draw_pin(canvas, cx, cy, color, filled)
        elif name == "close":
            canvas.create_line(cx - 3.5, cy - 3.5, cx + 3.5, cy + 3.5, fill=color, width=width, capstyle="round")
            canvas.create_line(cx + 3.5, cy - 3.5, cx - 3.5, cy + 3.5, fill=color, width=width, capstyle="round")

    def draw_pin(self, canvas: tk.Canvas, cx: float, cy: float, color: str, filled: bool) -> None:
        """画图钉图标。

        形状取自界面里置顶按钮用的 `pin-fill` / `pin-outline` 图标：一个斜着
        的钉身加一段针尖。置顶时钉身填实，取消置顶时只描边。
        """
        scale = PIN_ICON_SIZE / PIN_VIEWBOX
        offset_x = cx - PIN_ICON_SIZE / 2
        offset_y = cy - PIN_ICON_SIZE / 2
        stroke = max(1.0, PIN_STROKE * scale)
        body = svg_path_points(PIN_BODY_PATH, scale, offset_x, offset_y)
        needle = svg_path_points(PIN_NEEDLE_PATH, scale, offset_x, offset_y)
        for polygon in body:
            flat = [value for point in polygon for value in point]
            if len(flat) < 6:
                continue
            canvas.create_polygon(
                *flat,
                fill=color if filled else "",
                outline=color,
                width=stroke,
                joinstyle="round",
            )
        for polygon in needle:
            flat = [value for point in polygon for value in point]
            if len(flat) < 6:
                continue
            canvas.create_polygon(*flat, fill=color, outline=color, width=stroke, joinstyle="round")

    def draw_header(self, canvas: tk.Canvas, width: int, height: int, text: str, muted: str) -> None:
        """画顶部栏。

        列表展开时，顶部栏是一条带分隔线的横条；收起时整块浮窗就是顶部栏，
        下边缘也要跟着变成圆角。
        """
        surface = self.color("surface", "#f7f8fa")
        border = self.color("border", "#e3e5ea")
        background = self.color("background", "#ffffff")
        if self.collapsed:
            # 收起时整个浮窗就是顶部栏，四周都是圆角。
            rounded_rect(canvas, 1, 1, width - 1, height - 1, 11, fill=surface, outline="")
        else:
            rounded_rect(canvas, 1, 1, width - 1, HEADER_HEIGHT, 11, fill=surface, outline="")
            canvas.create_rectangle(1, HEADER_HEIGHT - 12, width - 1, HEADER_HEIGHT, fill=surface, outline="")
            canvas.create_line(1, HEADER_HEIGHT, width - 1, HEADER_HEIGHT, fill=border)
        canvas.create_text(
            PADDING,
            HEADER_HEIGHT / 2,
            text=text,
            anchor="w",
            fill=self.color("text", "#0f1115"),
            font=self.font_for(text, self.font_title, self.font_title_cjk),
        )
        # 标题后面的状态图标：与任务列表里的状态点同色同形。
        for state, cx, cy in self.header_icons:
            if state == "running":
                self.draw_spinner(canvas, cx, cy, self.state_color(state), surface)
            else:
                self.draw_dot(canvas, cx, cy, self.state_color(state))
        # 右侧的三个按钮。
        for name, x0, y0, x1, y1 in self.header_buttons:
            cx, cy = (x0 + x1) / 2, HEADER_HEIGHT / 2
            if name == self.hover_button:
                rounded_rect(
                    canvas,
                    x0 - BUTTON_HOVER_PAD,
                    (HEADER_HEIGHT - BUTTON_SIZE) / 2 - BUTTON_HOVER_PAD,
                    x1 + BUTTON_HOVER_PAD,
                    (HEADER_HEIGHT + BUTTON_SIZE) / 2 + BUTTON_HOVER_PAD,
                    6,
                    fill=background,
                    outline="",
                )
            if name == "collapse":
                self.draw_glyph(canvas, "collapse" if not self.collapsed else "expand", cx, cy, muted, True)
            elif name == "topmost":
                self.draw_glyph(canvas, "topmost", cx, cy, muted, self.topmost)
            elif name == "close":
                self.draw_glyph(canvas, "close", cx, cy, muted, True)

    def truncate(self, text: str, font: tkfont.Font, max_width: float) -> str:
        """把文本缩略到指定宽度内，放不下时末尾加省略号。"""
        if max_width <= 0:
            return ""
        if font.measure(text) <= max_width:
            return text
        low, high = 0, len(text)
        while low < high:
            middle = (low + high + 1) // 2
            if font.measure(text[:middle] + "…") <= max_width:
                low = middle
            else:
                high = middle - 1
        return text[:low] + "…"

    def visible_rows(self, height: int) -> int:
        """当前高度下能显示几行任务。

        底部留白不参与计算，免得窗口差一像素就少显示一行。
        """
        return max(0, (height - HEADER_HEIGHT) // ROW_HEIGHT)

    def clamp_scroll(self) -> None:
        """把滚动位置限制在合法范围内。"""
        height = max(HEADER_HEIGHT, self.root.winfo_height())
        rows = self.visible_rows(height)
        maximum = max(0, len(self.tasks) - rows)
        self.scroll_offset = max(0, min(maximum, self.scroll_offset))

    def draw(self) -> None:
        """重画整个面板。"""
        canvas = self.canvas
        canvas.delete("all")
        width = max(1, canvas.winfo_width())
        height = max(1, canvas.winfo_height())
        background = self.color("background", "#ffffff")
        surface = self.color("surface", "#f7f8fa")
        border = self.color("border", "#e3e5ea")
        text = self.color("text", "#0f1115")
        muted = self.color("muted", "#6b7280")

        canvas.configure(bg=TRANSPARENT_KEY)
        self.layout_header(width)
        if self.collapsed:
            # 收起时整块浮窗就是顶部栏，四周都是圆角。
            rounded_rect(canvas, 0, 0, width, height, 12, fill=surface, outline=border, width=1)
            self.draw_header(canvas, width, height, str(self.labels.get("title", "任务状态")), muted)
            return
        rounded_rect(canvas, 0, 0, width, height, 12, fill=background, outline=border, width=1)
        self.draw_header(canvas, width, height, str(self.labels.get("title", "任务状态")), muted)

        rows = self.visible_rows(height)
        self.clamp_scroll()
        start = self.scroll_offset
        end = min(len(self.tasks), start + rows)

        if not self.tasks:
            empty = str(self.labels.get("empty", "当前没有需要关注的任务"))
            canvas.create_text(
                width / 2,
                HEADER_HEIGHT + (height - HEADER_HEIGHT) / 2,
                text=empty,
                anchor="center",
                fill=muted,
                font=self.font_for(empty, self.font_row, self.font_row_cjk),
            )
        else:
            now = time.time() * 1000.0
            for index in range(start, end):
                task = self.tasks[index]
                row_top = HEADER_HEIGHT + (index - start) * ROW_HEIGHT
                row_bottom = row_top + ROW_HEIGHT
                hovered = index == self.hover
                if hovered:
                    rounded_rect(
                        canvas,
                        PADDING - 4,
                        row_top,
                        width - PADDING + 4,
                        row_bottom - 2,
                        8,
                        fill=surface,
                        outline="",
                    )
                row_background = surface if hovered else background
                # 行尾那一格：等待用户处理的任务写「待审批 / 计划待审 / 待回答」，
                # 其余写计时 —— 与界面里工作区题目行末尾那一格的选择一致。
                since = task.get("since")
                trailing = self.row_trailing_text(task, since, now)
                time_font = self.font_for(trailing, self.font_time, self.font_time_cjk)
                time_width = time_font.measure(trailing) if trailing != "" else 0
                time_left = width - PADDING - time_width

                text_left = PADDING + 16
                text_right = time_left - TIME_GAP
                title = str(task.get("title", ""))
                # 先画标题（走马灯时它会往左溢出），再用背景色把溢出部分盖掉，
                # 最后画状态图标与计时，这样它们不会被标题盖住。
                self.draw_title(
                    canvas,
                    index,
                    title,
                    text_left,
                    text_right,
                    row_top,
                    row_background,
                    text,
                )

                state = str(task.get("state", "idle"))
                dot_color = self.state_color(state)
                dot_x = PADDING + DOT_BOX / 2
                dot_y = row_top + ROW_HEIGHT / 2
                if state == "running":
                    # 运行中的任务用界面上那套加载图标。
                    self.draw_spinner(canvas, dot_x, dot_y, dot_color, row_background)
                else:
                    self.draw_dot(canvas, dot_x, dot_y, dot_color)

                if trailing != "":
                    canvas.create_text(
                        width - PADDING,
                        row_top + ROW_HEIGHT / 2,
                        text=trailing,
                        anchor="e",
                        fill=muted,
                        font=time_font,
                    )
            # 任务比窗口高时，右边画一条滚动条。
            if len(self.tasks) > rows and rows > 0:
                track_top = HEADER_HEIGHT + 2
                track_height = max(10, (end - start) * ROW_HEIGHT - 4)
                canvas.create_line(
                    width - PADDING + 1,
                    track_top,
                    width - PADDING + 1,
                    track_top + track_height,
                    fill=muted,
                    width=2,
                    capstyle="round",
                )

        # 右下角的缩放抓手（只改宽度）。
        grip = self.color("muted", "#9aa1ad")
        for offset in range(4):
            canvas.create_line(
                width - 6 - offset * 4,
                height - 6,
                width - 6,
                height - 6 - offset * 4,
                fill=grip,
            )

    def draw_title(
        self,
        canvas: tk.Canvas,
        index: int,
        title: str,
        left: float,
        right: float,
        row_top: float,
        row_background: str,
        color: str,
    ) -> None:
        """画一行任务标题。

        标题放不下时：平时缩略成省略号；鼠标停在上面时改成走马灯，按界面里
        工作区题目行的速度把整条标题慢慢滚出来，滚到头就停住。
        """
        cell = max(10.0, right - left)
        font = self.font_for(title, self.font_row, self.font_row_cjk)
        overflow = font.measure(title) - cell
        marqueeing = index == self.marquee_row and overflow > MIN_TITLE_REVEAL_PX and self.marquee_offset > 0
        center_y = row_top + ROW_HEIGHT / 2
        if not marqueeing:
            canvas.create_text(
                left,
                center_y,
                text=self.truncate(title, font, cell),
                anchor="w",
                fill=color,
                font=font,
            )
            return
        # 滚动中：整条标题向左偏移，两端用背景色方块盖住溢出的部分。
        offset = min(self.marquee_offset, overflow)
        center_y = row_top + ROW_HEIGHT / 2
        canvas.create_text(
            left - offset,
            center_y,
            text=title,
            anchor="w",
            fill=color,
            font=font,
        )
        # 遮盖只覆盖文字这一条带，行的上下圆角保持原样。
        band_top = center_y - 12
        band_bottom = center_y + 12
        canvas.create_rectangle(0, band_top, left, band_bottom, fill=row_background, outline="")
        canvas.create_rectangle(right, band_top, self.canvas.winfo_width(), band_bottom, fill=row_background, outline="")

    # -- 走马灯 ------------------------------------------------------------

    def font_for(self, text: str, latin: tkfont.Font, cjk: tkfont.Font) -> tkfont.Font:
        """按文字内容挑字体：含中文就用中文 UI 字体，否则用拉丁字体。"""
        return cjk if has_cjk(text) else latin

    def row_trailing_text(self, task: dict[str, Any], since: Any, now: float) -> str:
        """行尾那一格写什么。

        等待用户处理的任务写「待审批 / 计划待审 / 待回答」（与界面里工作区题目
        行末尾那一格一致），其余写进入当前状态之后过了多久。
        """
        if str(task.get("state", "")) == "warning":
            kind = str(task.get("pendingKind", "question"))
            key = {
                "approval": "pendingApproval",
                "plan-review": "pendingPlanReview",
            }.get(kind, "pendingAnswer")
            return str(self.labels.get(key, ""))
        if isinstance(since, (int, float)) and since > 0:
            return relative_label(float(since), now, self.labels)
        return ""

    def title_overflow(self, index: int) -> float:
        """某一行标题超出可用宽度的像素数（不超过 0 表示放得下）。"""
        if index < 0 or index >= len(self.tasks):
            return 0.0
        width = max(1, self.canvas.winfo_width())
        task = self.tasks[index]
        trailing = self.row_trailing_text(task, task.get("since"), time.time() * 1000.0)
        time_font = self.font_for(trailing, self.font_time, self.font_time_cjk)
        time_width = time_font.measure(trailing) if trailing != "" else 0
        right = width - PADDING - time_width - TIME_GAP
        cell = max(10.0, right - (PADDING + 16))
        title = str(task.get("title", ""))
        return self.font_for(title, self.font_row, self.font_row_cjk).measure(title) - cell

    def marquee_reset(self) -> None:
        """停下走马灯，标题回到缩略状态。"""
        self.marquee_row = -1
        self.marquee_offset = 0.0
        self.marquee_last = 0.0

    def marquee_step(self) -> bool:
        """推进走马灯；返回这一帧是否真的动了。"""
        if self.marquee_row < 0:
            return False
        overflow = self.title_overflow(self.marquee_row)
        if overflow <= MIN_TITLE_REVEAL_PX:
            return False
        now = time.monotonic()
        if self.marquee_last <= 0.0:
            self.marquee_last = now
            return False
        elapsed_ms = (now - self.marquee_last) * 1000.0
        self.marquee_last = now
        if self.marquee_offset >= overflow:
            # 滚到头就停住，直到指针离开这一行。
            return False
        self.marquee_offset = min(overflow, self.marquee_offset + elapsed_ms * TITLE_MARQUEE_PX_PER_MS)
        return True

    # -- 交互 -------------------------------------------------------------

    def row_at(self, y: float) -> int:
        """返回某个纵坐标落在的任务行下标。"""
        if self.collapsed or y < HEADER_HEIGHT:
            return -1
        index = self.scroll_offset + int((y - HEADER_HEIGHT) // ROW_HEIGHT)
        if 0 <= index < len(self.tasks):
            return index
        return -1

    def button_at(self, x: float, y: float) -> str | None:
        """返回某个坐标落在的顶部栏按钮。"""
        top = (HEADER_HEIGHT - BUTTON_SIZE) / 2
        bottom = (HEADER_HEIGHT + BUTTON_SIZE) / 2
        for name, x0, _y0, x1, _y1 in self.header_buttons:
            if x0 - BUTTON_HOVER_PAD <= x <= x1 + BUTTON_HOVER_PAD and top - BUTTON_HOVER_PAD <= y <= bottom + BUTTON_HOVER_PAD:
                return name
        return None

    def on_press(self, event: Any) -> None:
        """按下：判断是点按钮、拖动标题栏、缩放还是点中某一行。"""
        self.moved = False
        width = max(1, self.canvas.winfo_width())
        height = max(1, self.canvas.winfo_height())
        button = self.button_at(event.x, event.y)
        if button is not None:
            # 按下就执行：浮窗是无边框的顶层窗口，有时收不到松开事件。
            self.pressed_button = button
            self.handle_button(button)
            self.pressed_button = None
            return
        self.pressed_button = None
        if event.y <= HEADER_HEIGHT:
            self.drag_offset = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())
            return
        if event.x >= width - GRIP_SIZE and event.y >= height - GRIP_SIZE:
            self.resize_origin = (
                self.root.winfo_x(),
                self.root.winfo_y(),
                self.root.winfo_width(),
                self.root.winfo_height(),
            )
            return
        index = self.row_at(event.y)
        if index >= 0:
            self.activate(index)

    def on_drag(self, event: Any) -> None:
        """拖动：移动窗口或改变窗口宽度。"""
        if self.drag_offset is not None:
            self.moved = True
            self.user_moved = True
            x = event.x_root - self.drag_offset[0]
            y = event.y_root - self.drag_offset[1]
            x, y = self.clamp(
                int(x),
                int(y),
                self.root.winfo_width(),
                self.root.winfo_height(),
            )
            self.root.geometry(f"+{x}+{y}")
            return
        if self.resize_origin is not None:
            self.moved = True
            self.user_moved = True
            origin_x, origin_y, origin_width, origin_height = self.resize_origin
            # 高度跟着任务多少走，只有宽度可调。
            width = max(self.min_width(), origin_width + (event.x_root - origin_x - origin_width))
            # 放大时也不允许超出虚拟屏幕，否则浮窗会有一半在屏幕外。
            left, top, screen_width, _screen_height = self.virtual_screen()
            width = min(width, left + screen_width - origin_x)
            self.root.geometry(f"{int(width)}x{origin_height}+{origin_x}+{origin_y}")

    def on_release(self, event: Any) -> None:
        """松开：结束拖动或缩放。"""
        if self.drag_offset is not None or self.resize_origin is not None:
            self.drag_offset = None
            self.resize_origin = None
        self.pressed_button = None

    def on_wheel(self, event: Any) -> None:
        """滚轮：上下滚动任务列表。"""
        if self.collapsed:
            return
        step = -1 if event.delta > 0 else 1
        self.scroll_offset += step
        self.clamp_scroll()
        self.draw()

    def on_motion(self, event: Any) -> None:
        """移动指针：高亮所在的任务行与按钮，放不下标题的行开始走马灯。"""
        index = self.row_at(event.y)
        button = self.button_at(event.x, event.y)
        changed = index != self.hover or button != self.hover_button
        self.hover = index
        self.hover_button = button
        if index != self.marquee_row:
            # 换了一行：从这一行的开头重新滚。
            self.marquee_row = index if self.title_overflow(index) > MIN_TITLE_REVEAL_PX else -1
            self.marquee_offset = 0.0
            self.marquee_last = 0.0
            changed = True
        if changed:
            self.draw()

    def on_leave(self, _event: Any) -> None:
        """指针离开：取消高亮，停下走马灯。"""
        if self.hover != -1 or self.hover_button is not None:
            self.hover = -1
            self.hover_button = None
            self.draw()
        self.marquee_reset()

    def activate(self, index: int) -> None:
        """点中一行：请求宿主切到该任务，并把主窗口拉到前面。"""
        task = self.tasks[index]
        session_id = str(task.get("id", ""))
        if session_id == "":
            return
        self.host.focus(session_id)
        activate_harness()

    # -- 顶部栏按钮 --------------------------------------------------------

    def toggle_collapse(self) -> None:
        """收起或展开任务列表。"""
        self.collapsed = not self.collapsed
        x, y = self.root.winfo_x(), self.root.winfo_y()
        width = max(self.min_width(), self.root.winfo_width())
        height = self.window_height()
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.root.update_idletasks()
        # 尺寸变了，重新记一次基准，免得把收起的尺寸当成用户改动回报出去。
        self.last_reported = None
        self.marquee_reset()
        self.draw()

    def toggle_topmost(self) -> None:
        """置顶或取消置顶。"""
        self.topmost = not self.topmost
        self.topmost_local_until = time.monotonic() + 3.0
        try:
            self.root.attributes("-topmost", self.topmost)
        except tk.TclError:
            self.topmost = not self.topmost
            return
        self.host.set_topmost(self.topmost)
        self.draw()

    def close_panel(self) -> None:
        """关闭浮窗：宿主会把「显示浮窗」关掉，之后可以在插件管理页再打开。"""
        self.host.close()
        self.marquee_reset()
        self.root.after(150, self.root.destroy)

    def handle_button(self, name: str) -> None:
        """执行顶部栏按钮的动作。"""
        if name == "collapse":
            self.toggle_collapse()
        elif name == "topmost":
            self.toggle_topmost()
        elif name == "close":
            self.close_panel()

    def check_geometry(self) -> None:
        """窗口稳定下来之后把新的几何回报给宿主。

        拖动与缩放过程中窗口会不停变化，直接在松开鼠标的那一刻写一次并不稳
        妥（窗口移动本身可能让鼠标事件丢失）。因此这里比较当前几何与上次
        回报的几何，稳定一段时间之后再写。

        只有用户真的动过窗口才回报：浮窗刚摆好时系统可能会把窗口挪动几个
        像素，那不是用户的意图，也不该覆盖配置里的初始位置。高度跟着任务
        多少变，不算用户的改动。
        """
        current = (
            self.root.winfo_x(),
            self.root.winfo_y(),
            self.root.winfo_width(),
            self.root.winfo_height(),
        )
        if self.collapsed:
            # 收起时窗口只有顶部栏那么高，这不是用户想要的大小。
            self.last_reported = current
            self.pending_geometry = None
            return
        if current == self.last_reported:
            self.pending_geometry = None
            return
        if self.last_reported is None:
            # 第一次读到的是浮窗自己摆放的位置，不算改动，因此不回报。
            self.last_reported = current
            self.pending_geometry = None
            return
        if not self.user_moved:
            # 用户没有动过浮窗，就没什么好回报的：配置里记的就是摆放时用的
            # 几何。这里必须直接返回——窗口刚铺开时读到的尺寸可能还没到位，
            # 回报出去会把配置写坏。
            return
        if current[2] < self.min_width():
            # 窗口还没铺开时读到的尺寸没有意义，不回报。
            return
        if current != self.pending_geometry:
            self.pending_geometry = current
            self.pending_since = time.monotonic()
            return
        if time.monotonic() - self.pending_since < 0.3:
            return
        self.report_geometry()

    def report_geometry(self) -> None:
        """把当前的窗口位置与大小回报给宿主。

        高度是跟着任务多少走的，不是用户定的，因此只回报宽度与位置。
        """
        x = self.root.winfo_x()
        y = self.root.winfo_y()
        width = self.root.winfo_width()
        self.last_reported = (x, y, width, self.root.winfo_height())
        self.pending_geometry = None
        print(f"geometry {width}x{self.last_reported[3]}+{x}+{y}", flush=True)
        self.host.geometry(x, y, width)

    def run(self) -> None:
        """进入 Tk 事件循环。"""
        self.root.mainloop()


def parse_args(argv: list[str]) -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="DeepSeek Harness task status panel")
    parser.add_argument("--state-url", required=True, help="state endpoint")
    parser.add_argument("--focus-url", required=True, help="focus endpoint")
    parser.add_argument("--geometry-url", required=True, help="geometry endpoint")
    parser.add_argument("--topmost-url", required=True, help="topmost endpoint")
    parser.add_argument("--close-url", required=True, help="close endpoint")
    parser.add_argument("--token", required=True, help="shared secret")
    parser.add_argument("--width", type=int, default=360)
    parser.add_argument("--x", type=int, default=-1)
    parser.add_argument("--y", type=int, default=-1)
    parser.add_argument("--poll", type=int, default=800)
    parser.add_argument("--topmost", type=int, default=1)
    parser.add_argument("--parent-pid", type=int, default=0)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """启动浮窗。"""
    args = parse_args(argv)
    panel = Panel(args)
    panel.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
