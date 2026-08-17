export function logServiceReady(name) {
    const stamp = new Date().toISOString();
    console.log(`[${stamp}] starting ${name}`);
    console.log(`[${stamp}] ready`);
}
