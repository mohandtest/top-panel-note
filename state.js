import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function newTab(name) {
    return {id: GLib.uuid_string_random(), name, text: ''};
}

export function defaultState() {
    const tab = newTab('Note 1');
    return {version: 1, tabs: [tab], activeTab: tab.id, width: 420, height: 360};
}

export function validateState(value) {
    if (value?.version !== 1 || !Array.isArray(value.tabs) || !value.tabs.length)
        throw new Error('Unsupported or incomplete note data');
    const ids = new Set();
    for (const tab of value.tabs) {
        if (typeof tab.id !== 'string' || !tab.id || ids.has(tab.id) ||
            typeof tab.name !== 'string' || !tab.name.trim() || typeof tab.text !== 'string')
            throw new Error('Invalid tab data');
        ids.add(tab.id);
    }
    return {
        version: 1,
        tabs: value.tabs.map(({id, name, text}) => ({id, name, text})),
        activeTab: ids.has(value.activeTab) ? value.activeTab : value.tabs[0].id,
        width: Number.isFinite(value.width) && value.width > 0 ? value.width : 420,
        height: Number.isFinite(value.height) && value.height > 0 ? value.height : 360,
    };
}

export class NoteStore {
    constructor(directory = GLib.build_filenamev([GLib.get_user_data_dir(), 'easynotes']),
        legacyPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'top_panel_note_cache.txt'])) {
        this.directory = directory;
        this.file = Gio.File.new_for_path(GLib.build_filenamev([directory, 'state.json']));
        this.legacy = Gio.File.new_for_path(legacyPath);
        this.blocked = false;
        this.recoveryMessage = null;
    }

    load() {
        let bytes;
        try {
            [, bytes] = this.file.load_contents(null);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                // Preserve unreadable data, including future schema versions.
                this.blocked = true;
                throw error;
            }
        }
        if (bytes !== undefined) {
            let value;
            try {
                value = JSON.parse(new TextDecoder().decode(bytes));
                if (value?.version !== undefined && value.version !== 1) {
                    this.blocked = true;
                    throw new Error(`This note file uses unsupported format version ${value.version}`);
                }
                return validateState(value);
            } catch (error) {
                if (this.blocked)
                    throw error;
                // Move damaged data aside before recovery; do not overwrite it.
                const preserved = Gio.File.new_for_path(GLib.build_filenamev([
                    this.directory, `state-damaged-${GLib.uuid_string_random()}.json`,
                ]));
                try {
                    this.file.move(preserved, Gio.FileCopyFlags.NONE, null, null);
                } catch (preserveError) {
                    this.blocked = true;
                    throw preserveError;
                }
                this.recoveryMessage = 'Damaged data preserved in the notes folder.';
            }
        }
        // Atomic saves retain the previous version. Prefer that over the legacy note.
        const backup = Gio.File.new_for_path(`${this.file.get_path()}~`);
        try {
            const [, saved] = backup.load_contents(null);
            const recovered = validateState(JSON.parse(new TextDecoder().decode(saved)));
            this.recoveryMessage = 'Notes restored from backup. Previous data preserved.';
            return recovered;
        } catch (error) {
            if (error instanceof GLib.Error && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this.blocked = true;
                throw error;
            }
        }
        const state = defaultState();
        try {
            const [, bytes] = this.legacy.load_contents(null);
            state.tabs[0].text = new TextDecoder().decode(bytes);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this.blocked = true;
                throw error;
            }
        }
        return state;
    }

    save(state) {
        if (this.blocked)
            throw new Error('Original note data is unreadable and has been preserved');
        if (GLib.mkdir_with_parents(this.directory, 0o700) !== 0)
            throw new Error('Cannot create EasyNotes data directory');
        // Atomic, ordered writes also let disable() flush without surviving callbacks.
        this.file.replace_contents(new TextEncoder().encode(JSON.stringify(state, null, 2)),
            null, true, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
