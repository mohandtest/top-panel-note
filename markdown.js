// A deliberately small Markdown subset; only escaped, generated Pango markup.
export function escapeMarkup(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function inlineMarkdown(source) {
    let text = '';
    let markup = '';
    const links = [];
    const append = (value, before = '', after = '') => {
        text += value;
        markup += before + escapeMarkup(value) + after;
    };
    const pattern = /(`+)([^\n]*?)\1|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|(https?:\/\/[^\s<>]+)/g;
    let previous = 0;
    for (const match of source.matchAll(pattern)) {
        append(source.slice(previous, match.index));
        if (match[1]) {
            append(match[2], '<tt>', '</tt>');
        } else if (match[3] || match[9]) {
            const label = match[3] ?? match[9];
            const start = new TextEncoder().encode(text).length;
            append(label, '<span foreground="#99c1f1" underline="single">', '</span>');
            links.push({start, end: new TextEncoder().encode(text).length, url: match[4] ?? match[9]});
        } else if (match[5] || match[6]) {
            append(match[5] ?? match[6], '<b>', '</b>');
        } else {
            append(match[7] ?? match[8], '<i>', '</i>');
        }
        previous = match.index + match[0].length;
    }
    append(source.slice(previous));
    return {text, markup, links};
}

export function markdownBlocks(source) {
    const blocks = [];
    let code = null;
    let paragraph = [];
    const flush = () => {
        if (paragraph.length)
            blocks.push({kind: 'paragraph', ...inlineMarkdown(paragraph.join('\n'))});
        paragraph = [];
    };
    for (const line of source.split('\n')) {
        if (/^\s*```/.test(line)) {
            flush();
            if (code !== null) {
                blocks.push({kind: 'code', text: code.join('\n'), markup: escapeMarkup(code.join('\n')), links: []});
                code = null;
            } else {
                code = [];
            }
        } else if (code !== null) {
            code.push(line);
        } else if (!line.trim()) {
            flush();
        } else {
            const heading = /^(#{1,6})\s+(.+)$/.exec(line);
            const list = /^\s*(?:[-*+]\s+|(\d+)[.)]\s+)(.*)$/.exec(line);
            if (heading || list) {
                flush();
                blocks.push(heading
                    ? {kind: 'heading', level: heading[1].length, ...inlineMarkdown(heading[2])}
                    : {kind: 'list', ...inlineMarkdown(`${list[1] ? `${list[1]}.` : '•'} ${list[2]}`)});
            } else {
                paragraph.push(line);
            }
        }
    }
    flush();
    if (code !== null)
        blocks.push({kind: 'code', text: code.join('\n'), markup: escapeMarkup(code.join('\n')), links: []});
    return blocks;
}
