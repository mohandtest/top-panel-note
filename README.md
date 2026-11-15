# EasyNotes

A minimal GNOME panel notebook. Named tabs, a multiline editor,
Markdown preview, and a resizable popup that remembers its size.

## Install

GNOME Shell 45–51 is declared supported; development targets GNOME 51.

```sh
gnome-extensions pack --force --extra-source=state.js --extra-source=markdown.js .
gnome-extensions install --force easynotes@mohandtest.shell-extension.zip
gnome-extensions enable easynotes@mohandtest
```

If GNOME has not discovered the new extension, log out and back in, then enable it.
On Wayland, updated JavaScript may also require a new login to take effect.

## Use

Click the panel icon to open your notes. Enter inserts a newline; Escape closes
the popup. Changes save automatically.

Use **+** to add a tab. Double-click a tab to rename it, or use **…** for rename
and delete. Scroll the tab strip when it overflows. Drag either bottom corner
to resize the popup; use the left corner to widen it from the screen's right edge.

**Preview** renders headings, bold, italic, lists, code, and HTTP/HTTPS links.
**Edit** returns to the original text. Raw HTML is displayed as text.

Notes and popup size are stored in `~/.local/share/easynotes/state.json`.
The previous `~/.cache/top_panel_note_cache.txt` note is imported on first use
and left intact. Back up the EasyNotes data file to keep a copy of your notes.
The previous saved version is kept as `state.json~`. Damaged state files are
preserved separately before recovery. Save errors show their cause with
**Retry** and **Open Folder** actions; no separate permission grant is needed.

Licensed under [GPL v3](LICENSE).

Fork based on [Top Panel Note](https://github.com/sainathmurali/top-panel-note).
