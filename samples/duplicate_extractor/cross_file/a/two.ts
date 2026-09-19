function logBoot(service) {
    const stamp = new Date().toISOString();
    console.log(`[${stamp}] starting ${service}`);
    console.log(`[${stamp}] ready`);
}
