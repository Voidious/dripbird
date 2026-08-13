class Formatter {
    pad(text) {
        const trimmed = text.trim();
        return trimmed.padStart(40, " ");
    }
}

class Report {
    renderHeader(fmt: Formatter, title) {
        db.insert("logs", { title });
        const t = title.trim();
        return t.padStart(40, " ");
    }

    renderFooter(fmt: Formatter, subtitle) {
        db.delete("logs", { subtitle });
        const s = subtitle.trim();
        return s.padStart(40, " ");
    }
}
