function logOrder(orderId: string, total: number) {
    logTransaction(orderId, total);
}

function logPayment(paymentId: string, amount: number) {
    logTransaction(paymentId, amount);
}

function logTransaction(id: string, value: number) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${id}: $${value.toFixed(2)}`;
    console.log(entry);
}
