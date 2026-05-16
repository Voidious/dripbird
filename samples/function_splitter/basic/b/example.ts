function buildReport(data: number[], config: { label: string; scale: number }) {
    const header = `Report: ${config.label}`;
    const scaled = data.map((v) => v * config.scale);
    return buildReportStatistics(scaled, header);
}

function buildReportStatistics(scaled: number[], header: string) {
    const sum = scaled.reduce((a, b) => a + b, 0);
    const avg = sum / scaled.length;
    const min = Math.min(...scaled);
    const max = Math.max(...scaled);
    const range = max - min;
    const median = scaled.sort((a, b) => a - b)[Math.floor(scaled.length / 2)];
    const variance = scaled.reduce((acc, v) => acc + (v - avg) ** 2, 0) /
        scaled.length;
    const stddev = Math.sqrt(variance);
    const outliers = scaled.filter((v) => Math.abs(v - avg) > 2 * stddev);
    const summary = { header, avg, min, max, range, median, stddev, outliers };
    const lines: string[] = [];
    lines.push(header);
    lines.push(`Average: ${avg.toFixed(2)}`);
    lines.push(`Min: ${min.toFixed(2)}`);
    lines.push(`Max: ${max.toFixed(2)}`);
    lines.push(`Range: ${range.toFixed(2)}`);
    lines.push(`Median: ${median.toFixed(2)}`);
    lines.push(`Std Dev: ${stddev.toFixed(2)}`);
    lines.push(`Outliers: ${outliers.length}`);
    lines.push(`Total: ${sum.toFixed(2)}`);
    lines.push("---");
    for (const value of scaled) {
        lines.push(`  ${value.toFixed(2)}`);
    }
    lines.push(`\nSummary generated at ${new Date().toISOString()}`);
    return { summary, lines };
}
