class Formatter {
    pad(text) {
        const trimmed = text.trim();
        return trimmed.padStart(40, " ");
    }
}

class Report {
    renderHeader(fmt: Formatter, title) {
        db.insert("logs", { title });
        return fmt.pad(title);
    }

    renderFooter(fmt: Formatter, subtitle) {
        db.delete("logs", { subtitle });
        return fmt.pad(subtitle);
    }
}
