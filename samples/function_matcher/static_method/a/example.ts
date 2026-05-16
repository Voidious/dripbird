class Formatter {
    static pad(text) {
        const trimmed = text.trim();
        return trimmed.padStart(40, " ");
    }
}

class Report {
    renderHeader(title) {
        db.insert("logs", { title });
        const t = title.trim();
        return t.padStart(40, " ");
    }

    renderFooter(subtitle) {
        db.delete("logs", { subtitle });
        const s = subtitle.trim();
        return s.padStart(40, " ");
    }
}
