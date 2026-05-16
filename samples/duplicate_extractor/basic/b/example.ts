function logOrder(orderId: string, total: number) {
    logTransaction("Order", orderId, total);
}

function logPayment(paymentId: string, amount: number) {
    logTransaction("Payment", paymentId, amount);
}

function logTransaction(label: string, id: string, value: number) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${label} ${id}: $${value.toFixed(2)}`;
    console.log(entry);
}
