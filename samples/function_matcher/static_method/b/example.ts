class Formatter {
    static pad(text) {
        const trimmed = text.trim();
        return trimmed.padStart(40, " ");
    }
}

class Report {
    renderHeader(title) {
        db.insert("logs", { title });
        return Formatter.pad(title);
    }

    renderFooter(subtitle) {
        db.delete("logs", { subtitle });
        return Formatter.pad(subtitle);
    }
}
