import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {NoteStore, defaultState, newTab} from './state.js';
import {markdownBlocks} from './markdown.js';

function box(vertical = false, params = {}) {
    const orientation = St.BoxLayout.prototype.set_orientation
        ? {orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL}
        : {vertical};
    return new St.BoxLayout({...orientation, ...params});
}

function scrollChild(scroll, child) {
    if (scroll.set_child)
        scroll.set_child(child);
    else
        scroll.add_actor(child);
}

function button(label, accessibleName, callback, icon = null) {
    const actor = new St.Button({
        style_class: 'easynotes-button', can_focus: true,
        accessible_name: accessibleName,
    });
    if (icon)
        actor.set_child(new St.Icon({icon_name: icon, style_class: 'easynotes-icon'}));
    else
        actor.label = label;
    actor.connect('clicked', callback);
    return actor;
}

const EasyNotes = GObject.registerClass(class EasyNotes extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'EasyNotes', false);
        this.add_child(new St.Icon({icon_name: 'accessories-text-editor-symbolic', style_class: 'system-status-icon'}));
        this._store = new NoteStore();
        this._state = defaultState();
        this._saveId = 0;
        this._idleId = 0;
        this._focusId = 0;
        this._dirty = false;
        this._previewing = false;
        this._disposed = false;
        this._views = new Map();
        let loadError = null;
        try {
            this._state = this._store.load();
            this._dirty = true;
        } catch (error) {
            loadError = error;
        }

        this.menu.actor.add_style_class_name('easynotes-menu');
        // No activating menu item surrounds the editor.
        this._root = box(true, {style_class: 'easynotes-root'});
        this.menu.box.add_child(this._root);
        this._buildHeader();
        this._buildEditor();
        this._buildFooter();
        this._renderTabs();
        this._loadActiveTab();
        this._root.set_style(`width: ${this._state.width}px; height: ${this._state.height}px;`);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._applySize(this._state.width, this._state.height);
                this._focusEditor();
            } else {
                if (this._focusId) {
                    GLib.Source.remove(this._focusId);
                    this._focusId = 0;
                }
                this._finishRename();
                this._closeActions();
                this._endResize();
                this._flush();
            }
        });
        this._monitorId = Main.layoutManager.connect('monitors-changed', () => {
            this._applySize(this._state.width, this._state.height);
        });
        if (loadError)
            this._showError('Saved notes could not be opened. Original data is preserved.', loadError);
        else {
            this._flush();
            if (this._store.recoveryMessage && !this._dirty)
                this._showStorageMessage(this._store.recoveryMessage);
        }
    }

    _buildHeader() {
        const header = box(false, {style_class: 'easynotes-header', x_expand: true});
        this._root.add_child(header);
        this._tabScroll = new St.ScrollView({
            x_expand: true, hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._tabs = box(false, {style_class: 'easynotes-tabs'});
        scrollChild(this._tabScroll, this._tabs);
        this._tabScroll.connect('scroll-event', (_actor, event) => {
            const adjustment = this._tabScroll.hadjustment ?? this._tabScroll.hscroll.adjustment;
            const direction = event.get_scroll_direction();
            let delta;
            if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();
                delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * 40;
            } else {
                delta = direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT ? -60 : 60;
            }
            adjustment.value = Math.max(0, Math.min(adjustment.upper - adjustment.page_size, adjustment.value + delta));
            return Clutter.EVENT_STOP;
        });
        header.add_child(this._tabScroll);
        header.add_child(button('', 'Add note', () => this._addTab(), 'list-add-symbolic'));
        this._modeButton = button('Preview', 'Toggle Markdown preview', () => this._togglePreview());
        header.add_child(this._modeButton);
        header.add_child(button('', 'Note actions', () => {
            this._actions.visible = !this._actions.visible;
            this._confirm.hide();
        }, 'view-more-symbolic'));

        this._actions = box(false, {style_class: 'easynotes-actions', visible: false});
        this._actions.add_child(button('Rename', 'Rename note', () => this._beginRename()));
        this._deleteButton = button('Delete', 'Delete note', () => {
            this._actions.hide();
            this._confirm.show();
        });
        this._actions.add_child(this._deleteButton);
        this._root.add_child(this._actions);
        this._confirm = box(false, {style_class: 'easynotes-actions', visible: false});
        this._confirm.add_child(new St.Label({text: 'Delete this note?', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._confirm.add_child(button('Cancel', 'Cancel deletion', () => this._confirm.hide()));
        this._confirm.add_child(button('Delete', 'Confirm deletion', () => this._deleteTab()));
        this._root.add_child(this._confirm);
    }

    _buildEditor() {
        this._scroll = new St.ScrollView({
            style_class: 'easynotes-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
        });
        this._content = box(true, {x_expand: true, y_expand: true});
        scrollChild(this._scroll, this._content);
        this._root.add_child(this._scroll);
        this._entry = new St.Entry({
            style_class: 'easynotes-editor', hint_text: 'Write a note…',
            can_focus: true, x_expand: true, y_expand: false, y_align: Clutter.ActorAlign.START,
        });
        this._text = this._entry.clutter_text;
        this._text.set_single_line_mode(false);
        this._text.set_activatable(false);
        this._text.set_line_wrap(true);
        this._text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._entry.connect('style-changed', () => {
            this._text.set_color(this._entry.get_theme_node().get_foreground_color());
        });
        this._content.add_child(this._entry);
        this._content.reactive = true;
        this._content.connect('button-press-event', (_actor, event) => {
            if (!this._previewing && event.get_button() === 1 && event.get_source() === this._content) {
                this._focusEditor();
                this._text.set_cursor_position(-1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._preview = box(true, {style_class: 'easynotes-preview', x_expand: true, visible: false});
        this._content.add_child(this._preview);
        this._text.connect('text-changed', () => {
            if (this._loading)
                return;
            this._activeTab().text = this._entry.get_text();
            this._scheduleSave();
            this._queueCaretScroll();
        });
        this._text.connect('notify::cursor-position', () => this._queueCaretScroll());
        this._entry.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const key = event.get_key_symbol();
            if ((key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) && !this._text.has_preedit()) {
                this._text.delete_selection();
                this._text.insert_text('\n', this._text.get_cursor_position());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildFooter() {
        this._storageMessage = box(true, {style_class: 'easynotes-storage-message', visible: false});
        this._storageDetails = new St.Label({x_expand: true});
        this._storageDetails.clutter_text.set_line_wrap(true);
        this._storageDetails.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._storageDetails.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._storageMessage.add_child(this._storageDetails);
        const actions = box(false, {style_class: 'easynotes-actions'});
        this._retryButton = button('Retry', 'Retry saving notes', () => {
            this._dirty = true;
            this._flush();
        });
        actions.add_child(this._retryButton);
        actions.add_child(button('Open Folder', 'Open notes folder', () => {
            const folder = Gio.File.new_for_path(this._store.directory);
            const target = folder.query_exists(null) ? folder : folder.get_parent();
            try {
                Gio.AppInfo.launch_default_for_uri(target.get_uri(), global.create_app_launch_context(0, -1));
            } catch (error) {
                this._showError('Could not open notes folder.', error);
            }
        }));
        this._dismissMessage = button('Dismiss', 'Dismiss recovery message', () => this._storageMessage.hide());
        actions.add_child(this._dismissMessage);
        this._storageMessage.add_child(actions);
        this._root.add_child(this._storageMessage);
        const footer = box(false, {style_class: 'easynotes-footer'});
        // The right-hand panel popup sits at the screen edge. The left grip
        // lets it grow horizontally without needing space outside the monitor.
        this._leftGrip = this._resizeGrip('◣', 'Drag left corner to resize note');
        this._leftGrip.connect('button-press-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._startResize(event, this._leftGrip, -1);
            return Clutter.EVENT_STOP;
        });
        footer.add_child(this._leftGrip);
        this._status = new St.Label({text: '', style_class: 'easynotes-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        footer.add_child(this._status);
        this._grip = this._resizeGrip('◢', 'Drag to resize note');
        this._grip.connect('button-press-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._startResize(event);
            return Clutter.EVENT_STOP;
        });
        footer.add_child(this._grip);
        this._root.add_child(footer);
    }

    _resizeGrip(glyph, name) {
        const grip = new St.Widget({
            style_class: 'easynotes-grip', reactive: true, track_hover: true,
            accessible_name: name, layout_manager: new Clutter.BinLayout(),
        });
        grip.add_child(new St.Label({text: glyph}));
        return grip;
    }

    _activeTab() {
        return this._state.tabs.find(tab => tab.id === this._state.activeTab);
    }

    _renderTabs() {
        this._tabs.destroy_all_children();
        this._tabButtons = new Map();
        for (const tab of this._state.tabs) {
            const actor = button(tab.name, tab.name, () => this._switchTab(tab.id));
            actor.add_style_class_name('easynotes-tab');
            const label = actor.get_child();
            (label.clutter_text ?? label).set_ellipsize(Pango.EllipsizeMode.END);
            if (tab.id === this._state.activeTab)
                actor.add_style_pseudo_class('active');
            let lastPress = 0;
            actor.connect('captured-event', (_actor, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                    return Clutter.EVENT_PROPAGATE;
                const now = event.get_time();
                const doubleClick = lastPress && now - lastPress < 400;
                lastPress = now;
                if (event.get_button() === 1 && doubleClick) {
                    lastPress = 0;
                    this._switchTab(tab.id);
                    this._beginRename();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._tabs.add_child(actor);
            this._tabButtons.set(tab.id, actor);
        }
        this._deleteButton.reactive = this._state.tabs.length > 1;
        this._deleteButton.can_focus = this._state.tabs.length > 1;
    }

    _rememberView() {
        this._views.set(this._state.activeTab, {
            cursor: this._text.get_cursor_position(), bound: this._text.get_selection_bound(),
            scroll: this._vadjustment().value,
        });
    }

    _loadActiveTab() {
        this._loading = true;
        this._entry.set_text(this._activeTab().text);
        const view = this._views.get(this._state.activeTab);
        this._text.set_selection(view?.cursor ?? -1, view?.bound ?? -1);
        this._loading = false;
        if (this._previewing)
            this._renderPreview();
        this._vadjustment().value = view?.scroll ?? 0;
    }

    _switchTab(id) {
        if (this._state.activeTab === id)
            return;
        this._finishRename();
        this._rememberView();
        this._flush();
        this._state.activeTab = id;
        this._closeActions();
        for (const [tabId, actor] of this._tabButtons) {
            if (tabId === id)
                actor.add_style_pseudo_class('active');
            else
                actor.remove_style_pseudo_class('active');
        }
        this._loadActiveTab();
        this._scheduleSave();
        this._focusEditor();
    }

    _addTab() {
        this._finishRename();
        this._rememberView();
        this._flush();
        let number = 1;
        while (this._state.tabs.some(tab => tab.name === `Note ${number}`))
            number++;
        const tab = newTab(`Note ${number}`);
        this._state.tabs.push(tab);
        this._state.activeTab = tab.id;
        this._previewing = false;
        this._syncMode();
        this._closeActions();
        this._renderTabs();
        this._loadActiveTab();
        this._scheduleSave();
        this._focusEditor();
    }

    _deleteTab() {
        if (this._state.tabs.length < 2)
            return;
        const index = this._state.tabs.findIndex(tab => tab.id === this._state.activeTab);
        this._views.delete(this._state.activeTab);
        this._state.tabs.splice(index, 1);
        this._state.activeTab = this._state.tabs[Math.min(index, this._state.tabs.length - 1)].id;
        this._closeActions();
        this._renderTabs();
        this._loadActiveTab();
        this._scheduleSave();
        this._flush();
        this._focusEditor();
    }

    _beginRename() {
        if (this._renameEntry)
            return;
        this._closeActions();
        const tab = this._activeTab();
        this._renameId = tab.id;
        this._renameEntry = new St.Entry({text: tab.name, style_class: 'easynotes-rename', can_focus: true});
        this._tabButtons.get(tab.id).hide();
        this._tabs.insert_child_at_index(this._renameEntry, this._state.tabs.indexOf(tab));
        this._renameEntry.clutter_text.connect('activate', () => this._finishRename());
        this._renameEntry.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._finishRename(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._renameEntry.clutter_text.grab_key_focus();
        this._renameEntry.clutter_text.set_selection(0, -1);
    }

    _finishRename(commit = true) {
        if (!this._renameEntry)
            return;
        const entry = this._renameEntry;
        this._renameEntry = null;
        const tab = this._state.tabs.find(item => item.id === this._renameId);
        if (commit && tab && entry.text.trim()) {
            tab.name = entry.text.trim();
            this._scheduleSave();
        }
        entry.destroy();
        const actor = this._tabButtons.get(this._renameId);
        if (actor) {
            actor.label = tab.name;
            actor.accessible_name = tab.name;
            actor.show();
        }
        this._focusEditor();
    }

    _closeActions() {
        this._actions.hide();
        this._confirm.hide();
    }

    _syncMode() {
        this._entry.visible = !this._previewing;
        this._preview.visible = this._previewing;
        this._modeButton.label = this._previewing ? 'Edit' : 'Preview';
        this._modeButton.accessible_name = this._previewing ? 'Edit note' : 'Preview Markdown';
    }

    _togglePreview() {
        this._finishRename();
        this._closeActions();
        this._previewing = !this._previewing;
        this._syncMode();
        if (this._previewing)
            this._renderPreview();
        else
            this._focusEditor();
        this._vadjustment().value = 0;
        this._flush();
    }

    _renderPreview() {
        this._preview.destroy_all_children();
        const blocks = markdownBlocks(this._activeTab().text);
        if (!blocks.length)
            blocks.push({kind: 'empty', text: 'Nothing to preview', markup: 'Nothing to preview', links: []});
        for (const block of blocks) {
            const label = new St.Label({style_class: `easynotes-block easynotes-${block.kind}`, x_expand: true});
            const text = label.clutter_text;
            text.set_line_wrap(true);
            text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            text.set_ellipsize(Pango.EllipsizeMode.NONE);
            text.set_markup(block.markup);
            text.set_selectable(true);
            if (block.kind === 'heading')
                label.set_style(`font-size: ${Math.max(14, 24 - block.level * 2)}px; font-weight: bold;`);
            this._preview.add_child(label);
            if (block.links.length) {
                label.reactive = true;
                label.connect('button-release-event', (_actor, event) => {
                    if (event.get_button() !== 1 || text.get_selection())
                        return Clutter.EVENT_PROPAGATE;
                    const [ok, x, y] = text.transform_stage_point(...event.get_coords());
                    if (!ok)
                        return Clutter.EVENT_PROPAGATE;
                    const [ox, oy] = text.get_layout_offsets();
                    const [inside, index] = text.get_layout().xy_to_index((x - ox) * Pango.SCALE, (y - oy) * Pango.SCALE);
                    const link = inside && block.links.find(item => index >= item.start && index < item.end);
                    if (!link)
                        return Clutter.EVENT_PROPAGATE;
                    try {
                        Gio.AppInfo.launch_default_for_uri(link.url, global.create_app_launch_context(0, -1));
                    } catch (error) {
                        this._showError('Could not open link.', error);
                    }
                    return Clutter.EVENT_STOP;
                });
            }
        }
    }

    _vadjustment() {
        return this._scroll.vadjustment ?? this._scroll.vscroll.adjustment;
    }

    _focusEditor() {
        if (!this.menu.isOpen || this._disposed || this._focusId)
            return;
        // Popup key navigation runs after open-state-changed; focus once it finishes.
        this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusId = 0;
            if (this.menu.isOpen && !this._previewing && !this._renameEntry)
                this._text.grab_key_focus();
            const tab = this._tabButtons.get(this._state.activeTab);
            if (tab?.mapped) {
                const adjustment = this._tabScroll.hadjustment ?? this._tabScroll.hscroll.adjustment;
                if (tab.x < adjustment.value)
                    adjustment.value = tab.x;
                else if (tab.x + tab.width > adjustment.value + adjustment.page_size)
                    adjustment.value = tab.x + tab.width - adjustment.page_size;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueCaretScroll() {
        if (this._idleId || this._loading || this._previewing || !this.menu.isOpen)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            const [ok, , y, height] = this._text.position_to_coords(this._text.get_cursor_position());
            if (ok) {
                const adjustment = this._vadjustment();
                const top = y + this._entry.y + 10;
                if (top < adjustment.value)
                    adjustment.value = top;
                else if (top + height > adjustment.value + adjustment.page_size)
                    adjustment.value = top + height - adjustment.page_size + 10;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _applySize(width, height) {
        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        const area = Main.layoutManager.getWorkAreaForMonitor(Math.max(0, monitorIndex));
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const maxWidth = Math.max(100, area.width / scale - 32);
        const maxHeight = Math.max(100, area.height / scale - 48);
        this._state.width = Math.round(Math.min(maxWidth, Math.max(320, width)));
        this._state.height = Math.round(Math.min(maxHeight, Math.max(240, height)));
        const style = `width: ${this._state.width}px; height: ${this._state.height}px;`;
        if (this._root.get_style() !== style)
            this._root.set_style(style);
    }

    _startResize(event, grip = this._grip, horizontalDirection = 1) {
        this._endResize();
        this._finishRename();
        this._closeActions();
        const [x, y] = event.get_coords();
        this._drag = {x, y, width: this._state.width, height: this._state.height, horizontalDirection};
        // Observe pointer state only. Never grab or capture the desktop's input.
        // Release outside the grip is detected on the next tick (at most 20 ms).
        this._resizePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            try {
                const [cx, cy, modifiers] = global.get_pointer();
                if (!(modifiers & Clutter.ModifierType.BUTTON1_MASK) || !this.menu.isOpen) {
                    this._resizePollId = 0;
                    this._endResize();
                    this._flush();
                    return GLib.SOURCE_REMOVE;
                }
                this._updateResize(cx, cy);
                return GLib.SOURCE_CONTINUE;
            } catch (error) {
                this._resizePollId = 0;
                this._endResize();
                console.error('EasyNotes: stopped resizing after an error', error);
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _updateResize(x, y) {
        if (!this._drag)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this._drag.width + this._drag.horizontalDirection * (x - this._drag.x) / scale;
        const height = this._drag.height + (y - this._drag.y) / scale;
        if (Math.round(width) !== this._state.width || Math.round(height) !== this._state.height) {
            this._applySize(width, height);
            this._dirty = true;
        }
    }

    _endResize() {
        if (this._resizePollId) {
            GLib.Source.remove(this._resizePollId);
            this._resizePollId = 0;
        }
        this._drag = null;
    }

    _scheduleSave() {
        this._dirty = true;
        if (this._saveId)
            GLib.Source.remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._saveId = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        if (!this._dirty)
            return;
        try {
            this._store.save(this._state);
            this._dirty = false;
            this._status.text = '';
            this._storageMessage.hide();
        } catch (error) {
            this._showError('Changes have not been saved.', error);
        }
    }

    _showError(message, error) {
        this._status.text = 'Not saved';
        this._showStorageMessage(`${message}\n${error.message}\n${this._store.file.get_path()}`, true);
        console.error(`EasyNotes: ${message}`, error);
    }

    _showStorageMessage(message, failed = false) {
        this._storageDetails.text = message;
        this._retryButton.visible = failed;
        this._dismissMessage.visible = !failed;
        this._storageMessage.show();
    }

    destroy() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._finishRename();
        this._endResize();
        this._flush();
        if (this._focusId) {
            GLib.Source.remove(this._focusId);
            this._focusId = 0;
        }
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        if (this._monitorId) {
            Main.layoutManager.disconnect(this._monitorId);
            this._monitorId = 0;
        }
        super.destroy();
    }
});

export default class EasyNotesExtension extends Extension {
    enable() {
        this._indicator = new EasyNotes();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
