#!/usr/bin/env python3
"""XYZ Manager: every project kept with XYZ on one screen, with buttons for its folders and a one-click extract.

It only reads (`xyz list --json`) and runs `xyz extract`; it never saves, promotes or changes a project.
"""
import json, os, shutil, subprocess, threading, time
from pathlib import Path

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib, Pango, Gdk
try:
    gi.require_version('WebKit2', '4.1')
    from gi.repository import WebKit2
except (ValueError, ImportError):
    try:
        gi.require_version('WebKit2', '4.0')
        from gi.repository import WebKit2
    except (ValueError, ImportError):
        WebKit2 = None

HERE = Path(__file__).resolve().parent
XYZ_MJS = HERE.parent / 'bin' / 'xyz.mjs'
ROOT = Path(os.environ.get('XYZ_ROOT', Path.home() / 'XYZ'))
# The Cyclops seeded eye (an HTML/SVG page). Shown as it is, never changed; only its own page chrome is hidden.
EYE = Path(os.environ.get('XYZ_EYE_HTML', Path.home() / 'Documents/zeyedesign/cyclops-eye-seeded-life.html'))

BANNER = [
    '██╗  ██╗██╗   ██╗███████╗',
    '╚██╗██╔╝╚██╗ ██╔╝╚══███╔╝',
    ' ╚███╔╝  ╚████╔╝   ███╔╝ ',
    ' ██╔██╗   ╚██╔╝   ███╔╝  ',
    '██╔╝ ██╗   ██║   ███████╗',
    '╚═╝  ╚═╝   ╚═╝   ╚══════╝',
]
BANNER_COLOURS = ['#87deea', '#6fd0f0', '#56bff5', '#47a9f7', '#4a8ef3', '#5a74e8']
ASCII_EYE = '''          ┃
      ╭───┸───╮
     ╱ ╭─────╮ ╲
  ━━┫  │  ◉  │  ┣━━
     ╲ ╰─────╯ ╱
      ╰───┰───╯
          ┃'''

# pace the eye from outside (its own code untouched): fewer frames, the same motion. The manager sets the rate.
EYE_PACE_JS = '''
(() => {
  window.__xyzFps = 24;
  const raf = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = cb => raf(function tick(t) {
    if (t - last >= 1000 / window.__xyzFps - 1) { last = t; cb(t); } else raf(tick);
  });
})();
'''

# hide the eye page's own title, captions and controls; keep only the eye, on the manager's night background
EYE_CSS = '''
html, body { background: transparent !important; overflow: hidden !important; margin: 0 !important; }
main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
header, figcaption, .readout, nav, .seedControl, fieldset, footer { display: none !important; }
figure, .stage { margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; }
svg#eye { width: 100vw !important; height: 100vh !important; display: block; }
'''


def node():
    for cand in (os.environ.get('XYZ_NODE'), shutil.which('node'), str(Path.home() / '.local/bin/node'), '/usr/local/bin/node', '/usr/bin/node'):
        if cand and Path(cand).exists():
            return cand
    raise RuntimeError('Node.js was not found (set XYZ_NODE)')


def xyz(*args, timeout=600):
    r = subprocess.run([node(), str(XYZ_MJS), *args], capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, 'XYZ_WHO': os.environ.get('XYZ_WHO', 'xyz-manager')})
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().removeprefix('xyz: '))
    return r.stdout


def ago(ms):
    s = time.time() - ms / 1000
    if s < 90: return 'just now'
    if s < 5400: return f'{round(s / 60)} min ago'
    if s < 129600: return f'{round(s / 3600)} h ago'
    return f'{round(s / 86400)} days ago'


def open_path(path):
    subprocess.Popen(['xdg-open', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


CSS = b"""
window, .background, list, row, scrolledwindow, viewport { background-color: #090f19; color: #e2edf4; }
headerbar { background: #0d1523; border-bottom: 1px solid #1d2b40; color: #e2edf4; }
headerbar entry { background: #101b2c; color: #e2edf4; border-color: #24364f; }
.hero { background: linear-gradient(90deg, #0d1523, #090f19); border-bottom: 1px solid #1d2b40; padding: 6px 18px; }
.hero-tag { color: #9fb1c5; font-family: monospace; font-size: 12px; }
.statusline { color: #9fb1c5; font-family: monospace; font-size: 12px; padding: 6px 18px; }
row { border-bottom: 1px solid #142033; }
row:hover { background-color: #0d1523; }
button { background: #101b2c; color: #d7e6f2; border: 1px solid #24364f; box-shadow: none; text-shadow: none; }
button:hover { background: #16253b; border-color: #3b6a9a; }
button:disabled { color: #4b5d73; background: #0c1421; }
button.x-live { background: linear-gradient(180deg, #2a2112, #1b160c); border-color: #c9963c; color: #ffe6a0; }
button.x-live:hover { border-color: #ffe6a0; }
.project-card { padding: 12px 14px; }
.project-name { font-size: 15px; font-weight: bold; }
.dim { color: #9fb1c5; }
.mono { font-family: monospace; }
.chip { border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: bold; }
.chip-live { background: alpha(#2e9d5b, 0.25); }
.chip-unsaved { background: alpha(#d08a1b, 0.25); }
.chip-lanes { background: alpha(#3d7bd9, 0.25); }
"""


class Manager(Gtk.Window):
    def __init__(self):
        super().__init__(title='XYZ Manager')
        self.set_default_size(980, 720)
        self.set_icon_name('folder')
        prov = Gtk.CssProvider(); prov.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(self.get_screen(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        hb = Gtk.HeaderBar(show_close_button=True, title='XYZ Manager')
        self.set_titlebar(hb)
        self.search = Gtk.SearchEntry(placeholder_text='Find a project…')
        self.search.connect('search-changed', lambda *_: self.listbox.invalidate_filter())
        hb.pack_start(self.search)
        refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic', Gtk.IconSize.BUTTON)
        refresh.set_tooltip_text('Refresh'); refresh.connect('clicked', lambda *_: self.load())
        hb.pack_end(refresh)
        exports = Gtk.Button(label='Exports')
        exports.set_tooltip_text(f'Open {ROOT / "exports"} (where extracts go)')
        exports.connect('clicked', lambda *_: (ROOT / 'exports').mkdir(parents=True, exist_ok=True) or open_path(ROOT / 'exports'))
        hb.pack_end(exports)

        settings = Gtk.Settings.get_default()
        if settings: settings.set_property('gtk-application-prefer-dark-theme', True)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(box)
        box.pack_start(self.hero(), False, False, 0)
        self.status = Gtk.Label(xalign=0); self.status.get_style_context().add_class('statusline')
        box.pack_start(self.status, False, False, 0)
        sw = Gtk.ScrolledWindow(); box.pack_start(sw, True, True, 0)
        self.listbox = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.listbox.set_filter_func(self.matches)
        sw.add(self.listbox)
        self.loading = False; self.loaded_at = 0
        self.load()
        GLib.timeout_add_seconds(60, lambda: (self.load(), True)[1])
        self.connect('focus-in-event', lambda *_: (time.time() - self.loaded_at > 15 and self.load(), False)[1])

    def hero(self):
        hero = Gtk.Box(spacing=18); hero.get_style_context().add_class('hero')
        hero.pack_start(self.eye(), False, False, 0)
        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, valign=Gtk.Align.CENTER)
        banner = Gtk.Label(xalign=0)
        # DejaVu Sans Mono draws full blocks and box lines edge to edge; tight line height closes the gaps
        lines = '\n'.join(f'<span foreground="{c}">{GLib.markup_escape_text(line)}</span>' for line, c in zip(BANNER, BANNER_COLOURS))
        banner.set_markup(f'<span font_family="DejaVu Sans Mono" size="13000" line_height="0.82">{lines}</span>')
        text.pack_start(banner, False, False, 0)
        tag = Gtk.Label(xalign=0, label='X live  ·  Y source  ·  Z memory      every project, its whole story')
        tag.get_style_context().add_class('hero-tag')
        text.pack_start(tag, False, False, 0)
        hero.pack_start(text, False, False, 0)
        return hero

    def eye(self):
        if WebKit2 and EYE.is_file():
            ucm = WebKit2.UserContentManager()
            ucm.add_style_sheet(WebKit2.UserStyleSheet(EYE_CSS, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                                                       WebKit2.UserStyleLevel.USER, None, None))
            ucm.add_script(WebKit2.UserScript(EYE_PACE_JS, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                                              WebKit2.UserScriptInjectionTime.START, None, None))
            view = WebKit2.WebView.new_with_user_content_manager(ucm)
            view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
            view.set_size_request(270, 215)
            view.set_can_focus(False)
            # the eye page stays on its own file: no links, no network
            def policy(v, decision, kind):
                if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
                    uri = decision.get_navigation_action().get_request().get_uri()
                    if not uri.startswith('file://') or uri.split('#')[0] != EYE.as_uri():
                        decision.ignore(); return True
                if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
                    decision.ignore(); return True
                return False
            view.connect('decide-policy', policy)
            view.connect('context-menu', lambda *a: True)
            view.load_uri(EYE.as_uri())
            # 24 frames a second while you use the manager, 6 while it sits in the background
            def pace(fps):
                js = f'window.__xyzFps = {fps}'
                if hasattr(view, 'evaluate_javascript'): view.evaluate_javascript(js, -1, None, None, None, None, None)
                else: view.run_javascript(js, None, None, None)
            self.connect('focus-in-event', lambda *_: (pace(24), False)[1])
            self.connect('focus-out-event', lambda *_: (pace(6), False)[1])
            return view
        art = Gtk.Label()
        art.set_markup(f'<span font_family="DejaVu Sans Mono" foreground="#87deea" size="14000" line_height="0.9">{GLib.markup_escape_text(ASCII_EYE)}</span>')
        art.set_size_request(230, 150)
        return art

    def matches(self, row):
        q = self.search.get_text().strip().lower()
        return not q or q in row.search_text

    def load(self):
        if self.loading: return
        self.loading = True
        if not self.loaded_at: self.status.set_text('Reading projects…')
        def work():
            try: data = json.loads(xyz('list', '--json', timeout=120)); err = None
            except Exception as e: data, err = [], str(e)
            GLib.idle_add(self.show, data, err)
        threading.Thread(target=work, daemon=True).start()

    def show(self, projects, err):
        self.loading = False; self.loaded_at = time.time()
        scroll = self.listbox.get_parent().get_parent().get_vadjustment().get_value() if self.listbox.get_parent() else 0
        for child in self.listbox.get_children(): self.listbox.remove(child)
        if err:
            self.status.set_text(f'Could not read the projects: {err}'); return
        projects.sort(key=lambda p: -(p.get('active') or (p.get('last') or {}).get('at', 0)))
        for p in projects: self.listbox.add(self.card(p))
        self.listbox.show_all()
        GLib.idle_add(lambda: self.listbox.get_parent().get_parent().get_vadjustment().set_value(scroll) and False)
        unsaved = sum(1 for p in projects if p.get('unsaved'))
        self.status.set_text(f'{len(projects)} projects in {ROOT}' + (f' · {unsaved} with unsaved work' if unsaved else '') + f' · most active first · updated {time.strftime("%H:%M")}')

    def card(self, p):
        row = Gtk.ListBoxRow(activatable=False)
        row.search_text = f"{p['name']} {p.get('about', '')}".lower()
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        outer.get_style_context().add_class('project-card')
        row.add(outer)

        if p.get('error'):
            title = Gtk.Label(label=p['name'], xalign=0); title.get_style_context().add_class('project-name')
            outer.pack_start(title, False, False, 0)
            outer.pack_start(Gtk.Label(label=f"⚠ {p['error']}", xalign=0), False, False, 0)
            return row

        top = Gtk.Box(spacing=8)
        title = Gtk.Label(xalign=0)
        title.set_markup(f'<span foreground="#87deea">◉</span>  {GLib.markup_escape_text(p["name"])}')
        title.get_style_context().add_class('project-name')
        top.pack_start(title, False, False, 0)
        def chip(text, cls):
            l = Gtk.Label(label=text); l.get_style_context().add_class('chip'); l.get_style_context().add_class(cls)
            top.pack_start(l, False, False, 0)
        if p.get('liveLabel'): chip(f"live {p['liveLabel']}", 'chip-live')
        if p.get('unsaved'): chip(f"{p['unsaved']} unsaved", 'chip-unsaved')
        if p.get('lanes'): chip(f"{p['lanes']} lane{'s' if p['lanes'] != 1 else ''} open", 'chip-lanes')
        outer.pack_start(top, False, False, 0)

        if p.get('about'):
            plain = p['about'].replace('**', '').replace('`', '')  # notes are markdown; show them as plain words
            about = Gtk.Label(label=plain, xalign=0, wrap=True, max_width_chars=110, lines=2, ellipsize=Pango.EllipsizeMode.END)
            outer.pack_start(about, False, False, 0)
        last = p.get('last')
        if last:
            meta = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.END)
            act = p.get('active') or last['at']
            meta.set_text(f"active {ago(act)} · last receipt {last['id']} ({ago(last['at'])}, {last.get('who', '')}): {last['title']}")
            meta.get_style_context().add_class('dim')
            outer.pack_start(meta, False, False, 0)

        buttons = Gtk.Box(spacing=6)
        def button(label, tip, fn, sensitive=True):
            b = Gtk.Button(label=label); b.set_tooltip_text(tip); b.set_sensitive(sensitive)
            b.connect('clicked', lambda *_: fn(b)); buttons.pack_start(b, False, False, 0); return b
        x_current = Path(p['x']) / 'current'
        live = x_current.exists()
        home_name = Path(p['home']).name
        xb = button(f"{home_name}  ·  live {p.get('liveLabel') or ''}".rstrip() + "  (X)" if live else f"{home_name}  (X)",
               f"The live version: {x_current.resolve() if live else 'nothing promoted yet'}", lambda b: open_path(x_current.resolve()), live)
        if live: xb.get_style_context().add_class('x-live')
        button('Source (Y)', p['y'], lambda b: open_path(p['y']))
        button('Memory (Z)', p['z'], lambda b: open_path(p['z']))
        notes = Path(p['z']) / 'NOTES.md'
        button('Notes', str(notes), lambda b: open_path(notes), notes.exists())
        button('Extract .zip', f"X, Y and Z in one .zip, to {ROOT / 'exports'}", lambda b: self.extract(p, b))
        outer.pack_start(buttons, False, False, 2)
        return row

    def extract(self, p, button):
        button.set_sensitive(False); button.set_label('Extracting…')
        def work():
            try: r = json.loads(xyz('extract', p['name'], '--json')); err = None
            except Exception as e: r, err = None, str(e)
            GLib.idle_add(self.extracted, p, button, r, err)
        threading.Thread(target=work, daemon=True).start()

    def extracted(self, p, button, r, err):
        button.set_sensitive(True); button.set_label('Extract .zip')
        if err:
            d = Gtk.MessageDialog(transient_for=self, message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.CLOSE, text=f"{p['name']} couldn't be extracted")
            d.format_secondary_text(err); d.run(); d.destroy(); return
        size = r['size'] / 1e6
        d = Gtk.MessageDialog(transient_for=self, message_type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.NONE, text=f"{p['name']} extracted")
        d.format_secondary_text(f"{r['file']}\n{size:.1f} MB · {r['y']} files from Y · {r['receipts']} receipts from Z"
                                + (f"\n{r['unsaved']} unsaved file(s) are in the zip but not in a receipt." if r.get('unsaved') else ''))
        d.add_button('Show in folder', 1); d.add_button('Close', 0)
        if d.run() == 1: open_path(Path(r['file']).parent)
        d.destroy()


if __name__ == '__main__':
    win = Manager()
    win.connect('destroy', Gtk.main_quit)
    win.show_all()
    Gtk.main()
