class Formatter {
    pad(text) {
        const trimmed = text.trim();
        return trimmed.padStart(40, " ");
    }

    renderHeader(title) {
        db.insert("logs", { title });
        return this.pad(title);
    }

    renderFooter(subtitle) {
        db.delete("logs", { subtitle });
        return this.pad(subtitle);
    }
}
